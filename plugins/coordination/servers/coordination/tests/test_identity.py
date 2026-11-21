"""S1-ID against the real stack: the real access-control middleware over the SQL key store, the real
service layer, the real `/sessions` routes and `/mcp`, and a real Postgres (the pinned image).

Stand-ins: the clock (a hand-moved `FixedClock`), and a stub for what S1-WAKE builds (the parked-
listener table), which is all the spec's "closes the parked listener with 410" can be tested against
until WAKE exists.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
import sqlalchemy as sa
from a2a.types import a2a_pb2 as pb
from conftest import run
from mcp_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    CARD_MAC,
    CONV_KEY,
    NOT_BOUND,
    ROOT_KEY,
    agy_meta,
    local_caller,
    make_env,
)

from coordination.auth.records import REMOTE_PEER, Principal
from coordination.mcp.tools import McpTools
from coordination.store.tables import session_aliases, session_conversations

PARENT_KEY = "antigravity.google/parent_conversation_id"
HSID = "3f2a9c1d-1111-4222-8333-444455556666"
HSID2 = "9b4e7a02-1111-4222-8333-444455556666"


@pytest.fixture
def env(pg_db):
    return make_env(pg_db)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def post(client, token, body, path="/sessions", **kw):
    return client.http.post(path, json=body, headers=auth(token), **kw)


def register(client, token, hsid=HSID, card=CARD_CLAUDE, **extra):
    return post(client, token, {"card": card, "harness_session_id": hsid, **extra})


def listing(client, token, **params):
    return client.http.get("/sessions", params=params, headers=auth(token))


# POST /sessions ------------------------------------------------------------------------------------


def test_register_creates_then_refreshes_and_is_idempotent(env):
    c = env.client()
    first = register(c, env.keys.claude, name_hint="agents-bridge-52", harness_version="2.1.300")
    assert first.status_code == 201, first.text
    body = first.json()
    assert body == {
        "handle": f"{CARD_CLAUDE}/agents-bridge-52~3f2a9c1d",
        "card": CARD_CLAUDE,
        "created": True,
        "bind_with": "a2a_hello",
        "aliases": [],
    }
    assert first.headers["cache-control"] == "no-store"
    env.clock.advance(minutes=5)
    again = register(c, env.keys.claude, name_hint="agents-bridge-52")
    assert again.status_code == 200 and again.json()["handle"] == body["handle"] and again.json()["created"] is False
    (row,) = env.session_rows()
    assert (row.handle, row.card_id, row.harness_session_id, row.ended_at) == (body["handle"], CARD_CLAUDE, HSID, None)
    assert row.last_seen_at == env.clock.now() and row.registered_at < row.last_seen_at  # refreshing updates last_seen_at
    (logged,) = env.audit_rows("session_registered")  # one row, for the creation only
    assert (logged.subject, logged.actor, logged.detail_json["card_id"]) == (body["handle"], env.keys.ids["claude"], CARD_CLAUDE)


def test_the_hint_becomes_the_name_and_an_empty_hint_the_sid8(env):
    c = env.client()
    assert register(c, env.keys.claude, HSID, name_hint="My Session!! v2").json()["handle"] == f"{CARD_CLAUDE}/mysessionv2~3f2a9c1d"
    assert register(c, env.keys.claude, HSID2).json()["handle"] == f"{CARD_CLAUDE}/9b4e7a02~9b4e7a02"  # unnamed: reading B [design]
    third = register(c, env.keys.claude, str(uuid.uuid4()), name_hint="!!!").json()["handle"]
    assert third.split("/")[1].split("~")[0] == third.split("~")[1]


def test_nothing_the_server_must_not_keep_is_accepted_or_stored(env):
    c = env.client()
    for extra in ({"cwd": "/home/user/project"}, {"pid": 123}, {"hostname": "x"}, {"path": "/x"}):
        r = register(c, env.keys.claude, **extra)
        assert r.status_code == 400 and r.json()["code"] == "invalid_request", extra
        assert "/home/user" not in r.text  # the value is never echoed
    assert env.session_rows() == []
    register(c, env.keys.claude)
    (row,) = env.session_rows()
    assert set(row._mapping) == {"handle", "card_id", "harness_session_id", "registered_at", "last_seen_at", "ended_at"}


@pytest.mark.parametrize(
    "body",
    [
        [],
        "text",
        {},
        {"card": CARD_CLAUDE},
        {"harness_session_id": HSID},
        {"card": CARD_CLAUDE, "harness_session_id": ""},
        {"card": CARD_CLAUDE, "harness_session_id": "x" * 129},
        {"card": CARD_CLAUDE, "harness_session_id": "has space"},
        {"card": CARD_CLAUDE, "harness_session_id": 7},
        {"card": 7, "harness_session_id": HSID},
        {"card": CARD_CLAUDE, "harness_session_id": HSID, "name_hint": 7},
        {"card": CARD_CLAUDE, "harness_session_id": HSID, "harness_version": "v" * 65},
    ],
)
def test_register_refuses_a_bad_body(env, body):
    c = env.client()
    r = post(c, env.keys.claude, body)
    assert r.status_code == 400 and r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "invalid_request" and r.json()["status"] == 400
    assert env.session_rows() == []


def test_register_refuses_a_body_that_is_not_json(env):
    c = env.client()
    r = c.http.post("/sessions", content=b"{not json", headers={**auth(env.keys.claude), "Content-Type": "application/json"})
    assert r.status_code == 400 and env.session_rows() == []


def test_a_key_cannot_register_under_another_card(env):
    """Acceptance: a key for claude-code@box cannot register under antigravity@box (403)."""
    c = env.client()
    r = register(c, env.keys.claude, card=CARD_AGY)
    assert r.status_code == 403 and r.json()["code"] == "wrong_card"
    assert register(c, env.keys.agy, card=CARD_CLAUDE).status_code == 403
    assert register(c, env.keys.claude, card=CARD_MAC).status_code == 403
    assert env.session_rows() == [] and env.audit_rows("session_registered") == []


def test_only_a_local_harness_key_reaches_sessions(env):
    c = env.client()
    for path, method in (("/sessions", "POST"), ("/sessions", "GET"), ("/sessions/end", "POST")):
        assert c.http.request(method, path).status_code == 401  # no key
        for token in (env.keys.peer, env.keys.status):
            r = c.http.request(method, path, json={"card": CARD_CLAUDE, "harness_session_id": HSID}, headers=auth(token))
            assert r.status_code == 403, (path, method)
    assert env.session_rows() == []


def test_methods_are_checked_after_authentication(env):
    c = env.client()
    assert c.http.delete("/sessions", headers=auth(env.keys.claude)).status_code == 405
    assert c.http.get("/sessions/end", headers=auth(env.keys.claude)).status_code == 405


def test_two_claude_sessions_with_the_same_name_never_share_a_handle_or_a_binding(env):
    """Acceptance: equal requested names get two different ~sid8 suffixes and two bindings."""
    c = env.client()
    h1 = register(c, env.keys.claude, HSID, name_hint="c6-same").json()["handle"]
    h2 = register(c, env.keys.claude_other, HSID2, name_hint="c6-same").json()["handle"]
    assert h1 == f"{CARD_CLAUDE}/c6-same~3f2a9c1d" and h2 == f"{CARD_CLAUDE}/c6-same~9b4e7a02" and h1 != h2
    a, b = env.client(), env.client()
    for client, token, handle in ((a, env.keys.claude, h1), (b, env.keys.claude_other, h2)):
        client.initialize(token)
        assert client.call(token, "a2a_hello", {"handle": handle}).data["handle"] == handle
    env.add_session(f"{CARD_AGY}/sender~aaaaaaa1")
    env.send(local_caller(CARD_AGY, handle=f"{CARD_AGY}/sender~aaaaaaa1", key_id="beefbeef"), h1, "for one")
    assert len(a.call(env.keys.claude, "a2a_inbox").tasks) == 1
    assert b.call(env.keys.claude_other, "a2a_inbox").tasks == []


def test_different_names_and_different_sessions_never_share_a_handle_even_when_registered_at_once(env):
    async def go():
        from coordination.identity import IdentityService, SessionRegistry

        ident = IdentityService(SessionRegistry(env.engine, env.clock), env.clock, audit=env.audit_log)
        same = await asyncio.gather(*(ident.register(CARD_CLAUDE, "feedfeed", HSID, "n") for _ in range(6)))
        distinct = await asyncio.gather(
            *(ident.register(CARD_CLAUDE, "feedfeed", f"{i:08x}-0000-4000-8000-000000000000", "same") for i in range(6))
        )
        return same, distinct

    same, distinct = run(go())
    assert len({r.session.handle for r in same}) == 1 and sum(r.created for r in same) == 1
    assert len({r.session.handle for r in distinct}) == 6 and all(r.created for r in distinct)
    assert len(env.session_rows()) == 7 and len(env.audit_rows("session_registered")) == 7


def test_a_same_sid8_collision_is_rejected_and_never_suffixed(env):
    """Acceptance [design]: two session ids that share the first 8 hex characters under one card and
    one name get the clear error, the first keeps its handle, and no suffixed handle appears."""
    c = env.client()
    first = register(c, env.keys.claude, "3f2a9c1d-aaaa-4000-8000-000000000001", name_hint="same")
    clash = register(c, env.keys.claude, "3f2a9c1d-bbbb-4000-8000-000000000002", name_hint="same")
    assert first.status_code == 201
    assert clash.status_code == 409 and clash.json()["code"] == "handle_collision"
    (row,) = env.session_rows()
    assert row.handle == first.json()["handle"] and row.harness_session_id.endswith("0001")
    # The first session still works; and with a different name the same sid8 is a different handle.
    assert register(c, env.keys.claude, "3f2a9c1d-aaaa-4000-8000-000000000001", name_hint="same").status_code == 200


def test_resume_gives_the_same_handle_and_clear_a_new_one(env):
    c = env.client()
    first = register(c, env.keys.claude, HSID, name_hint="work").json()["handle"]
    assert register(c, env.keys.claude, HSID, name_hint="work").json()["handle"] == first  # --resume, same session id
    cleared = register(c, env.keys.claude, HSID2, name_hint="work").json()["handle"]  # /clear: a new session id
    assert cleared != first and len(env.session_rows()) == 2


def test_the_claude_path_register_then_hello_binds_the_mcp_session(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="claude-path").json()["handle"]  # SessionStart hook
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    assert mcp.call(env.keys.claude, "a2a_inbox").text == NOT_BOUND
    hello = mcp.call(env.keys.claude, "a2a_hello", {"handle": handle})  # the model's first call
    assert hello.data["handle"] == handle and hello.data["bound"] is True
    assert mcp.call(env.keys.claude, "a2a_inbox").is_error is False
    # A resume: a new Mcp-Session-Id, the same handle, bound again.
    again = env.client()
    again.initialize(env.keys.claude)
    assert again.call(env.keys.claude, "a2a_hello", {"handle": register(c, env.keys.claude, name_hint="claude-path").json()["handle"]}).data["handle"] == handle
    assert len(env.session_rows()) == 1


# aliases ------------------------------------------------------------------------------------------


def test_a_later_sessionstart_name_becomes_an_alias_of_an_auto_registered_conversation(env):
    conv = "9b4e7a02-1111-4222-8333-444455556666"
    mcp = env.client()
    mcp.initialize(env.keys.agy)
    auto = mcp.call(env.keys.agy, "a2a_hello", {"name": "ignored"}, meta=agy_meta(conv)).data["handle"]  # first call, D30
    assert auto == f"{CARD_AGY}/9b4e7a02~9b4e7a02"
    c = env.client()
    r = register(c, env.keys.agy, conv, card=CARD_AGY, name_hint="Refactor-1")  # the SessionStart hook arrives late
    assert r.status_code == 200 and r.json()["handle"] == auto and r.json()["created"] is False
    assert r.json()["aliases"] == ["refactor-1"]
    assert len(env.session_rows()) == 1 and len(env.audit_rows("session_registered")) == 1  # one handle, one registration
    # The alias is recorded once and listed; the handle never changes.
    assert register(c, env.keys.agy, conv, card=CARD_AGY, name_hint="refactor-1").json()["aliases"] == ["refactor-1"]
    (listed,) = listing(c, env.keys.agy, handle=auto).json()["sessions"]
    assert listed["aliases"] == ["refactor-1"] and listed["handle"] == auto
    assert run(_by_alias(env, CARD_AGY, "refactor-1")) == [auto]
    assert run(_by_alias(env, CARD_CLAUDE, "refactor-1")) == []  # scoped to the card


async def _by_alias(env, card, alias):
    from coordination.identity import SessionRegistry

    return await SessionRegistry(env.engine, env.clock).by_alias(card, alias)


def test_the_handles_own_name_is_not_an_alias_and_aliases_are_bounded(env):
    c = env.client()
    handle = register(c, env.keys.claude, HSID, name_hint="work").json()["handle"]
    assert register(c, env.keys.claude, HSID, name_hint="WORK").json()["aliases"] == []
    assert register(c, env.keys.claude, HSID, name_hint="!!!").json()["aliases"] == []  # nothing to add
    for i in range(12):
        register(c, env.keys.claude, HSID, name_hint=f"other-{i}")
    aliases = register(c, env.keys.claude, HSID).json()["aliases"]
    assert aliases == [f"other-{i}" for i in range(8)]  # at most 8
    assert register(c, env.keys.claude, HSID).json()["handle"] == handle


def test_an_alias_never_moves_the_handle_to_another_session(env):
    c = env.client()
    h1 = register(c, env.keys.claude, HSID, name_hint="one").json()["handle"]
    h2 = register(c, env.keys.claude, HSID2, name_hint="two").json()["handle"]
    register(c, env.keys.claude, HSID2, name_hint="one")  # the second session also calls itself "one"
    assert run(_by_alias(env, CARD_CLAUDE, "one")) == [h2]  # a lookup aid; the first "one" is its handle's name
    assert h1 != h2 and len(env.session_rows()) == 2


# POST /sessions/end -------------------------------------------------------------------------------


class ParkedListeners:
    """What S1-WAKE's table does for the end hook: answer every parked request of the handle with
    410. A stub; WAKE builds the real one and registers `close_session` the same way."""

    def __init__(self) -> None:
        self.closed: list[str] = []
        self.status: dict[str, int] = {}

    def park(self, handle: str) -> None:
        self.status[handle] = 0  # parked: no answer yet

    def close_session(self, handle: str) -> int:
        self.closed.append(handle)
        if self.status.get(handle) == 0:
            self.status[handle] = 410
            return 1
        return 0

    def is_listening(self, handle: str) -> bool:
        return self.status.get(handle) == 0

    def newest_listening(self, card_id: str) -> str | None:
        return None


def app_with_listeners(env, table: ParkedListeners):
    app = env.app(listeners=table)
    app.state.identity.end_hooks.register("wake", table.close_session)  # what S1-WAKE does
    return app


def test_ending_a_session_closes_its_parked_listener_with_410(env):
    """Acceptance: POST /sessions/end marks ended and closes the parked listener with 410."""
    table = ParkedListeners()
    c = env.client(app_with_listeners(env, table))
    handle = register(c, env.keys.claude, name_hint="ending").json()["handle"]
    other = register(c, env.keys.claude, HSID2, name_hint="staying").json()["handle"]
    table.park(handle)
    table.park(other)
    assert listing(c, env.keys.claude, handle=handle).json()["sessions"][0]["liveness"] == "listening"
    r = post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    assert r.status_code == 200, r.text
    assert r.json() == {"handle": handle, "card": CARD_CLAUDE, "ended": True, "already_ended": False, "listeners_closed": 1}
    assert table.status[handle] == 410 and table.status[other] == 0  # only that session's listener
    (row,) = [x for x in env.session_rows() if x.handle == handle]
    assert row.ended_at == env.clock.now()
    assert listing(c, env.keys.claude, handle=handle).json()["sessions"] == []  # live sessions only by default (Z17)
    assert listing(c, env.keys.claude, handle=handle, include_ended="1").json()["sessions"][0]["liveness"] == "ended"
    assert listing(c, env.keys.claude, handle=other).json()["sessions"][0]["liveness"] == "listening"


def test_end_by_card_and_harness_session_id_and_idempotent(env):
    table = ParkedListeners()
    c = env.client(app_with_listeners(env, table))
    handle = register(c, env.keys.claude).json()["handle"]
    table.park(handle)
    first = post(c, env.keys.claude, {"card": CARD_CLAUDE, "harness_session_id": HSID}, "/sessions/end")
    assert first.status_code == 200 and first.json()["already_ended"] is False and first.json()["listeners_closed"] == 1
    second = post(c, env.keys.claude, {"card": CARD_CLAUDE, "harness_session_id": HSID}, "/sessions/end")
    assert second.status_code == 200 and second.json()["already_ended"] is True
    assert table.closed == [handle, handle]  # the hooks run again, so a racing listener is not left parked
    (row,) = env.session_rows()
    ended_at = row.ended_at
    env.clock.advance(minutes=1)
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    assert env.session_rows()[0].ended_at == ended_at  # the first end time stands


def test_end_refusals(env):
    c = env.client()
    handle = register(c, env.keys.claude).json()["handle"]
    env.add_session(f"{CARD_AGY}/other~bbbbbbb1")
    cases = [
        ({}, 400),
        ({"handle": handle, "harness_session_id": HSID}, 400),
        ({"handle": handle, "card": CARD_CLAUDE}, 400),
        ({"card": CARD_CLAUDE}, 400),
        ({"harness_session_id": HSID}, 400),
        ({"card": CARD_CLAUDE, "harness_session_id": "bad id"}, 400),
        ({"handle": 7}, 400),
        ({"handle": handle, "cwd": "/x"}, 400),
        ({"card": CARD_AGY, "harness_session_id": HSID}, 403),  # a card that is not the key's
        ({"handle": f"{CARD_AGY}/other~bbbbbbb1"}, 403),  # another card's session
        ({"handle": f"{CARD_CLAUDE}/nobody~aaaaaaa7"}, 404),
        ({"handle": "not a handle"}, 404),
        ({"card": CARD_CLAUDE, "harness_session_id": "nobody"}, 404),
    ]
    for body, status in cases:
        r = post(c, env.keys.claude, body, "/sessions/end")
        assert r.status_code == status, (body, r.status_code, r.text)
    assert all(row.ended_at is None for row in env.session_rows())  # none of them ended anything


def test_a_failing_end_hook_does_not_undo_the_end(env):
    app = env.app()

    def broken(handle: str) -> int:
        raise RuntimeError("boom")

    app.state.identity.end_hooks.register("broken", broken)
    c = env.client(app)
    handle = register(c, env.keys.claude).json()["handle"]
    r = post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    assert r.status_code == 200 and r.json()["ended"] is True and "boom" not in r.text
    assert env.session_rows()[0].ended_at is not None


def audit_of(env, event: str, handle: str | None = None):
    """(subject, actor, detail) of every audit row of `event`, oldest first."""
    return [
        (r.subject, r.actor, r.detail_json)
        for r in env.audit_rows(event)
        if handle is None or r.subject == handle
    ]


def sender_of(env, card=CARD_AGY):
    env.add_session(f"{card}/sender~aaaaaaa1")
    return local_caller(card, handle=f"{card}/sender~aaaaaaa1", key_id="beefbeef")


def test_an_ended_session_revives_on_a_resumed_registration_and_the_409_is_gone(env):
    """Z17: the same harness session id brings back the same handle. The old `409 session_ended`
    answer of `POST /sessions` no longer exists."""
    c = env.client()
    first = register(c, env.keys.claude, name_hint="gone")
    handle = first.json()["handle"]
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    assert env.session_rows()[0].ended_at is not None
    env.clock.advance(minutes=1)
    r = register(c, env.keys.claude, name_hint="gone")
    assert r.status_code == 200 and r.status_code != 409
    assert r.json() == {"handle": handle, "card": CARD_CLAUDE, "created": False, "bind_with": "a2a_hello", "aliases": []}
    (row,) = env.session_rows()  # no second row, same handle
    assert row.handle == handle and row.ended_at is None and row.last_seen_at == env.clock.now()
    assert [d for _s, _a, d in audit_of(env, "session_registered", handle)] == [
        {"card_id": CARD_CLAUDE, "via": "hook", "revived": False},
        {"card_id": CARD_CLAUDE, "via": "hook", "revived": True},
    ]
    # A revived session is live again: listed by default, and a further registration is a plain refresh.
    assert [s["handle"] for s in listing(c, env.keys.claude).json()["sessions"]] == [handle]
    assert register(c, env.keys.claude, name_hint="gone").status_code == 200
    assert len(audit_of(env, "session_registered")) == 2


def test_a_revived_session_is_offered_the_tasks_that_were_orphaned_while_it_was_ended(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="gone").json()["handle"]
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    task = env.send(sender_of(env), handle, "to the ended one")
    assert task.status.state == pb.TaskState.TASK_STATE_SUBMITTED  # accepted and orphaned, never redirected
    assert run(env.service.pending_count(handle)) == 0 and run(env.service.has_wake_pending(handle)) is False
    register(c, env.keys.claude, name_hint="gone")  # the harness session resumes
    assert run(env.service.pending_count(handle)) == 1 and run(env.service.has_wake_pending(handle)) is True
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    hello = mcp.call(env.keys.claude, "a2a_hello", {"handle": handle})
    assert hello.data["bound"] is True and hello.data["pending"] == 1
    offered = mcp.call(env.keys.claude, "a2a_inbox").tasks
    assert len(offered) == 1  # the orphaned task is offered again, to the same handle


def test_concurrent_resumes_of_an_ended_session_revive_it_once(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="gone").json()["handle"]
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")

    async def go():
        from coordination.identity import IdentityService, SessionRegistry

        ident = IdentityService(SessionRegistry(env.engine, env.clock), env.clock, audit=env.audit_log)
        return await asyncio.gather(*(ident.register(CARD_CLAUDE, "feedfeed", HSID, "gone") for _ in range(6)))

    results = run(go())
    assert {r.session.handle for r in results} == {handle} and sum(r.revived for r in results) == 1
    assert [d["revived"] for _s, _a, d in audit_of(env, "session_registered", handle)] == [False, True]


def test_hello_of_an_ended_handle_revives_it(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="gone").json()["handle"]
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    env.send(sender_of(env), handle, "while ended")
    env.clock.advance(minutes=3)
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    hello = mcp.call(env.keys.claude, "a2a_hello", {"handle": handle})
    assert hello.is_error is False and hello.data["handle"] == handle and hello.data["bound"] is True
    assert hello.data["pending"] == 1  # offered again
    (row,) = [r for r in env.session_rows() if r.handle == handle]
    assert row.ended_at is None and row.last_seen_at == env.clock.now()
    assert audit_of(env, "session_registered", handle)[-1][2] == {"card_id": CARD_CLAUDE, "via": "hello", "revived": True}
    assert len(audit_of(env, "session_registered")) == 2
    again = env.client()
    again.initialize(env.keys.claude)
    assert again.call(env.keys.claude, "a2a_hello", {"handle": handle}).is_error is False  # a live handle: a plain bind
    assert len(audit_of(env, "session_registered")) == 2


def test_hello_of_an_ended_handle_of_another_card_is_still_refused(env):
    handle = f"{CARD_AGY}/other~bbbbbbb1"
    env.add_session(handle, ended=True)
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    assert mcp.call(env.keys.claude, "a2a_hello", {"handle": handle}).data["error"] == "wrong_card"
    assert env.session_rows()[0].ended_at is not None and audit_of(env, "session_registered") == []


def test_an_ended_agy_conversation_and_its_subagents_revive_on_the_next_call(env):
    c = env.client()
    handle = register(c, env.keys.agy, A4_ROOT, card=CARD_AGY).json()["handle"]
    mcp = env.client()
    mcp.initialize(env.keys.agy)
    assert mcp.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_SUB, A4_ROOT, A4_ROOT)).is_error is False  # grouped
    post(c, env.keys.agy, {"handle": handle}, "/sessions/end")
    env.send(sender_of(env, CARD_CLAUDE), handle, "while ended")
    # The first call after the end revives the root; the same handle comes back, and the task is offered.
    first = mcp.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_SUB, A4_ROOT, A4_ROOT))
    assert first.is_error is False and len(first.tasks) == 1
    (row,) = [r for r in env.session_rows() if r.handle == handle]
    assert row.handle == handle and row.ended_at is None
    for meta in (a4_meta(A4_ROOT, A4_ROOT), a4_meta(A4_SUB, A4_ROOT, A4_ROOT), a4_meta(A4_SUB2, A4_ROOT, A4_ROOT)):
        assert mcp.call(env.keys.agy, "a2a_inbox", meta=meta).is_error is False
    assert [d for _s, _a, d in audit_of(env, "session_registered", handle)] == [
        {"card_id": CARD_AGY, "via": "hook", "revived": False},
        {"card_id": CARD_AGY, "via": "auto_agy", "revived": True},
    ]
    # The conversation itself (not a subagent) ending and resuming is the same rule.
    post(c, env.keys.agy, {"handle": handle}, "/sessions/end")
    assert mcp.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_ROOT, A4_ROOT)).is_error is False
    assert len([r for r in env.session_rows() if r.handle == handle]) == 1 and len(audit_of(env, "session_registered")) == 3


# lifecycle audit events (Z17) ---------------------------------------------------------------------


def test_session_registered_names_how_the_session_was_registered(env):
    c = env.client()
    hooked = register(c, env.keys.claude, HSID, name_hint="hooked").json()["handle"]
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    helloed = mcp.call(env.keys.claude, "a2a_hello", {"name": "helloed"}).data["handle"]
    agy = env.client()
    agy.initialize(env.keys.agy)
    auto = agy.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=agy_meta(HSID2)).data["handle"]
    for _ in range(2):  # repeats of each route write nothing more
        register(c, env.keys.claude, HSID, name_hint="hooked")
        mcp.call(env.keys.claude, "a2a_hello", {"name": "helloed"})
        agy.call(env.keys.agy, "a2a_inbox", meta=agy_meta(HSID2))
    rows = {s: (a, d) for s, a, d in audit_of(env, "session_registered")}
    assert len(audit_of(env, "session_registered")) == 3
    assert rows[hooked] == (env.keys.ids["claude"], {"card_id": CARD_CLAUDE, "via": "hook", "revived": False})
    assert rows[helloed] == (env.keys.ids["claude"], {"card_id": CARD_CLAUDE, "via": "hello", "revived": False})
    assert rows[auto] == (env.keys.ids["agy"], {"card_id": CARD_AGY, "via": "auto_agy", "revived": False})
    assert env.audit_rows("registration") == []  # the old event name is not written any more


def test_session_ended_explicit_is_written_once_per_ending(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="done").json()["handle"]
    other = register(c, env.keys.claude, HSID2, name_hint="other").json()["handle"]
    assert audit_of(env, "session_ended") == []
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    post(c, env.keys.claude, {"card": CARD_CLAUDE, "harness_session_id": HSID}, "/sessions/end")  # already ended
    assert audit_of(env, "session_ended") == [(handle, env.keys.ids["claude"], {"via": "explicit"})]
    register(c, env.keys.claude, name_hint="done")  # revived, then ended again: a second ending
    post(c, env.keys.claude, {"handle": handle}, "/sessions/end")
    assert audit_of(env, "session_ended", handle) == [(handle, env.keys.ids["claude"], {"via": "explicit"})] * 2
    assert audit_of(env, "session_ended", other) == []


def test_alias_added_is_written_once_per_new_alias(env):
    c = env.client()
    handle = register(c, env.keys.claude, HSID, name_hint="work").json()["handle"]
    register(c, env.keys.claude, HSID, name_hint="WORK")  # the handle's own name: no alias
    register(c, env.keys.claude, HSID, name_hint="renamed")
    register(c, env.keys.claude, HSID, name_hint="renamed")  # already an alias: nothing
    register(c, env.keys.claude, HSID, name_hint="third")
    assert audit_of(env, "alias_added") == [
        (handle, env.keys.ids["claude"], {"alias": "renamed"}),
        (handle, env.keys.ids["claude"], {"alias": "third"}),
    ]
    for i in range(12):  # past the bound of 8 aliases nothing is added, so nothing is written
        register(c, env.keys.claude, HSID, name_hint=f"other-{i}")
    assert len(audit_of(env, "alias_added")) == 8


def test_hello_rebinds_a_handle_held_by_another_live_mcp_session_of_the_card(env):
    """Z17: the newest `a2a_hello` wins; the old binding is dropped and gets the unbound error."""
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="resumed").json()["handle"]
    app = env.app()  # one process: both Mcp-Session-Ids are in the same map
    m1, m2 = env.client(app), env.client(app)
    m1.initialize(env.keys.claude)
    m2.initialize(env.keys.claude)
    assert m1.call(env.keys.claude, "a2a_hello", {"handle": handle}).data["bound"] is True
    assert audit_of(env, "session_rebound") == []  # a first binding is not a rebind
    assert m1.call(env.keys.claude, "a2a_inbox").is_error is False
    hello = m2.call(env.keys.claude, "a2a_hello", {"handle": handle})  # the resumed session
    assert hello.is_error is False and hello.data["handle"] == handle
    assert m1.call(env.keys.claude, "a2a_inbox").text == NOT_BOUND  # M1 lost it
    assert m2.call(env.keys.claude, "a2a_inbox").is_error is False
    assert audit_of(env, "session_rebound") == [
        (handle, env.keys.ids["claude"], {"from_binding": m1.session_id[:8], "to_binding": m2.session_id[:8]})
    ]
    m2.call(env.keys.claude, "a2a_hello", {"handle": handle})  # a repeat on the holder: nothing moves
    assert len(audit_of(env, "session_rebound")) == 1
    # M1 says hello again and takes it back; one more rebind, the other direction.
    assert m1.call(env.keys.claude, "a2a_hello", {"handle": handle}).is_error is False
    assert m2.call(env.keys.claude, "a2a_inbox").text == NOT_BOUND and m1.call(env.keys.claude, "a2a_inbox").is_error is False
    assert audit_of(env, "session_rebound")[-1][2] == {"from_binding": m2.session_id[:8], "to_binding": m1.session_id[:8]}
    assert len(audit_of(env, "session_rebound")) == 2


def test_rebind_reaches_another_key_of_the_same_card_but_never_another_card(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="shared").json()["handle"]
    app = env.app()
    m1, m2, m3 = env.client(app), env.client(app), env.client(app)
    m1.initialize(env.keys.claude)
    m2.initialize(env.keys.claude_other)  # another key, the same card
    m3.initialize(env.keys.mac)  # another card: cannot take the handle at all
    m1.call(env.keys.claude, "a2a_hello", {"handle": handle})
    assert m3.call(env.keys.mac, "a2a_hello", {"handle": handle}).data["error"] == "wrong_card"
    assert m1.call(env.keys.claude, "a2a_inbox").is_error is False  # the refusal moved nothing
    assert m2.call(env.keys.claude_other, "a2a_hello", {"handle": handle}).is_error is False
    assert m1.call(env.keys.claude, "a2a_inbox").text == NOT_BOUND
    assert len(audit_of(env, "session_rebound")) == 1


def test_an_idle_mcp_binding_is_not_a_live_holder(env):
    """A binding idle past the Mcp-Session-Id TTL is gone already: taking the handle is a first
    binding, not a rebind."""
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="stale").json()["handle"]
    app = env.app()
    m1, m2 = env.client(app), env.client(app)
    m1.initialize(env.keys.claude)
    m1.call(env.keys.claude, "a2a_hello", {"handle": handle})
    env.clock.advance(hours=env.config.session_idle_ttl_h, minutes=1)
    m2.initialize(env.keys.claude)
    assert m2.call(env.keys.claude, "a2a_hello", {"handle": handle}).is_error is False
    assert audit_of(env, "session_rebound") == []


def test_idle_expiry_ends_each_session_by_name_fires_the_end_hooks_and_audits_it(env):
    table = ParkedListeners()
    app = app_with_listeners(env, table)
    c = env.client(app)
    ident = app.state.identity
    h_a = register(c, env.keys.claude, HSID, name_hint="idle-a").json()["handle"]
    env.clock.advance(minutes=1)
    h_b = register(c, env.keys.claude, HSID2, name_hint="idle-b").json()["handle"]
    table.park(h_b)
    ttl = timedelta(hours=env.config.session_idle_ttl_h)
    env.clock.advance(hours=env.config.session_idle_ttl_h, minutes=1)
    h_c = register(c, env.keys.claude, "44444444-0000-4000-8000-000000000000", name_hint="fresh").json()["handle"]
    ended = run(ident.end_idle(env.clock.now() - ttl))
    assert [e.handle for e in ended] == [h_a, h_b]  # by name, oldest first
    assert [e.report.total_closed for e in ended] == [0, 1] and all(e.ended_now for e in ended)
    assert table.closed == [h_a, h_b] and table.status[h_b] == 410  # the end hooks ran for each
    rows = {r.handle: r for r in env.session_rows()}
    assert rows[h_a].ended_at is not None and rows[h_b].ended_at is not None and rows[h_c].ended_at is None
    assert sorted(audit_of(env, "session_ended")) == sorted(
        [(h_a, "system", {"via": "idle_ttl"}), (h_b, "system", {"via": "idle_ttl"})]
    )
    assert run(ident.end_idle(env.clock.now() - ttl)) == [] and len(audit_of(env, "session_ended")) == 2  # once each
    assert table.closed == [h_a, h_b]


def test_idle_expiry_leaves_a_session_that_called_in_after_the_scan(env):
    app = env.app()
    c = env.client(app)
    handle = register(c, env.keys.claude, name_hint="busy").json()["handle"]
    ttl = timedelta(hours=env.config.session_idle_ttl_h)
    env.clock.advance(hours=env.config.session_idle_ttl_h, minutes=1)
    cutoff = env.clock.now() - ttl
    ident = app.state.identity
    assert run(ident.registry.idle_handles(cutoff)) == [handle]
    register(c, env.keys.claude, name_hint="busy")  # it calls in between the scan and the end
    assert run(ident.registry.end(handle, idle_before=cutoff)) is False
    assert env.session_rows()[0].ended_at is None and audit_of(env, "session_ended") == []


# GET /sessions ------------------------------------------------------------------------------------


def test_list_shape_all_cards_and_liveness_states(env):
    table = ParkedListeners()
    c = env.client(app_with_listeners(env, table))
    h_listen = register(c, env.keys.claude, HSID, name_hint="listen").json()["handle"]
    h_active = register(c, env.keys.claude, HSID2, name_hint="active").json()["handle"]
    h_old = register(c, env.keys.claude, "11111111-0000-4000-8000-000000000000", name_hint="old").json()["handle"]
    h_ended = register(c, env.keys.claude, "22222222-0000-4000-8000-000000000000", name_hint="ended").json()["handle"]
    h_agy = register(c, env.keys.agy, "33333333-0000-4000-8000-000000000000", card=CARD_AGY, name_hint="agy").json()["handle"]
    post(c, env.keys.claude, {"handle": h_ended}, "/sessions/end")
    table.park(h_listen)
    env.clock.advance(minutes=20)  # everything above is now past the 15 minute window
    register(c, env.keys.claude, HSID2, name_hint="active")  # a refresh: active again
    body = listing(c, env.keys.claude, include_ended="1").json()
    by = {s["handle"]: s for s in body["sessions"]}
    assert {h: s["liveness"] for h, s in by.items()} == {
        h_listen: "listening", h_active: "active", h_old: "registered", h_ended: "ended", h_agy: "registered",
    }
    assert set(by[h_active]) == {"handle", "card", "liveness", "registered_at", "last_seen_at", "pending", "aliases"}
    assert by[h_agy]["card"] == CARD_AGY  # a local-harness key sees every card
    assert [s["handle"] for s in body["sessions"]][0] == h_active  # newest seen first
    assert listing(c, env.keys.agy, include_ended="1").json()["sessions"] == body["sessions"]  # and so does another harness's key


def test_list_filters_limit_and_pending(env):
    c = env.client()
    h1 = register(c, env.keys.claude, HSID, name_hint="one").json()["handle"]
    h2 = register(c, env.keys.claude, HSID2, name_hint="two").json()["handle"]
    h3 = register(c, env.keys.agy, "33333333-0000-4000-8000-000000000000", card=CARD_AGY).json()["handle"]
    post(c, env.keys.claude, {"handle": h2}, "/sessions/end")
    env.send(local_caller(CARD_AGY, handle=h3, key_id="beefbeef"), h1, "one task")
    env.send(local_caller(CARD_AGY, handle=h3, key_id="beefbeef"), h2, "to an ended session")
    s = lambda **p: {x["handle"]: x for x in listing(c, env.keys.claude, **p).json()["sessions"]}  # noqa: E731
    assert s(include_ended="1")[h1]["pending"] == 1 and s(include_ended="1")[h2]["pending"] == 0  # an ended session has none
    assert list(s(handle=h1)) == [h1]
    assert set(s(card=CARD_AGY)) == {h3}
    assert set(s(include_ended="0")) == {h1, h3} and set(s()) == {h1, h3}  # live only is the default (Z17)
    assert set(s(include_ended="1")) == {h1, h2, h3}
    assert len(s(limit="2", include_ended="1")) == 2
    assert listing(c, env.keys.claude, handle=f"{CARD_CLAUDE}/nobody~aaaaaaa7").json() == {"sessions": []}


@pytest.mark.parametrize(
    "params",
    [{"handle": "not a handle"}, {"card": "NOPE"}, {"include_ended": "yes"}, {"limit": "0"}, {"limit": "201"}, {"limit": "x"}, {"cwd": "/x"}],
)
def test_list_refuses_bad_parameters(env, params):
    assert listing(env.client(), env.keys.claude, **params).status_code == 400


# agy ----------------------------------------------------------------------------------------------


def test_a_registered_agy_conversation_is_found_by_the_tool_call_without_a_second_registration(env):
    """The agy hook registers `conversationId`; the first tools/call then finds the same handle."""
    c = env.client()
    handle = register(c, env.keys.agy, HSID, card=CARD_AGY, name_hint="hooked").json()["handle"]
    mcp = env.client()
    mcp.initialize(env.keys.agy)
    assert mcp.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=agy_meta(HSID)).data["handle"] == handle
    assert len(env.session_rows()) == 1 and len(env.audit_rows("session_registered")) == 1


A4_ROOT = "a4000000-0000-4000-8000-0000000000a4"
A4_SUB = "a2000000-0000-4000-8000-0000000000a2"
A4_SUB2 = "a3000000-0000-4000-8000-0000000000a3"
A4_OTHER = "b1000000-0000-4000-8000-0000000000b1"


def a4_meta(conv, root=None, parent=None, progress=1):
    """The `_meta` shape recorded in the SP2 A4 results: artifacts_dir, conversation_id,
    root_conversation_id, parent_conversation_id (subagents only) and a progress token."""
    meta = {
        "antigravity.google/artifacts_dir": f"~/.gemini/antigravity-cli/brain/{conv}",
        CONV_KEY: conv,
        "progressToken": f"{uuid.uuid4()}:{progress}",
    }
    if root:
        meta[ROOT_KEY] = root
    if parent:
        meta[PARENT_KEY] = parent
    return meta


def test_agy_replay_of_the_recorded_meta_shapes(env):
    """Acceptance: same process, two conversations, two handles; resume, the same handle; a subagent
    groups under the root; `Mcp-Session-Id` shared across conversations does not merge them."""
    proc = env.client()
    proc.initialize(env.keys.agy)  # one agy process, one Mcp-Session-Id (A4 T1)
    shared = proc.session_id

    def hello(client, meta):
        return client.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=meta).data["handle"]

    h_root = hello(proc, a4_meta(A4_ROOT, A4_ROOT))
    h_other = hello(proc, a4_meta(A4_OTHER, A4_OTHER))  # /clear in the same process: a new conversation
    assert h_root != h_other
    # A subagent call (T4): its own conversation id, root and parent are the parent's.
    h_sub = hello(proc, a4_meta(A4_SUB, A4_ROOT, A4_ROOT))
    assert h_sub == h_root
    # A nested subagent whose parent is the first subagent still groups under the root.
    assert hello(proc, a4_meta(A4_SUB2, A4_ROOT, A4_SUB)) == h_root
    assert len(env.session_rows()) == 2  # no sub-invocation became a top-level session
    # A restart and `agy --conversation <id>` (T3): a new process and Mcp-Session-Id, the same ids.
    resumed = env.client(env.app())
    resumed.initialize(env.keys.agy)
    assert resumed.session_id != shared
    assert hello(resumed, a4_meta(A4_ROOT, A4_ROOT)) == h_root
    assert hello(resumed, a4_meta(A4_SUB, A4_ROOT, A4_ROOT)) == h_root  # the known sub-invocation, from its link
    # Tasks sent to each handle reach only that conversation although one Mcp-Session-Id served both.
    env.add_session(f"{CARD_CLAUDE}/sender~aaaaaaa1")
    sender = local_caller(CARD_CLAUDE, handle=f"{CARD_CLAUDE}/sender~aaaaaaa1", key_id="beefbeef")
    env.send(sender, h_other, "to the other conversation")
    assert len(proc.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_OTHER, A4_OTHER)).tasks) == 1
    assert proc.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_ROOT, A4_ROOT)).tasks == []
    assert proc.call(env.keys.agy, "a2a_inbox", meta=a4_meta(A4_SUB, A4_ROOT, A4_ROOT)).tasks == []


def test_parent_conversation_id_is_recorded_for_provenance(env):
    proc = env.client()
    proc.initialize(env.keys.agy)
    proc.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=a4_meta(A4_SUB, A4_ROOT, A4_ROOT))  # the subagent is seen first
    proc.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=a4_meta(A4_SUB2, A4_ROOT, A4_SUB))
    proc.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=a4_meta(A4_SUB2, A4_ROOT, "ff000000-0000-4000-8000-00000000ffff"))  # first sight wins
    rows = {r.conversation_id: r for r in run(_links(env))}
    (root_row,) = env.session_rows()
    assert root_row.harness_session_id == A4_ROOT  # the root was registered, not the subagent
    assert set(rows) == {A4_SUB, A4_SUB2}
    assert rows[A4_SUB].parent_conversation_id == A4_ROOT and rows[A4_SUB].root_conversation_id == A4_ROOT
    assert rows[A4_SUB2].parent_conversation_id == A4_SUB and rows[A4_SUB2].handle == root_row.handle
    assert all(r.card_id == CARD_AGY for r in rows.values())
    assert len(env.audit_rows("session_registered")) == 1  # one registration for the whole group


async def _links(env):
    async with env.engine.connect() as conn:
        return list((await conn.execute(sa.select(session_conversations))).all())


def test_a_malformed_parent_id_is_dropped_not_trusted(env):
    proc = env.client()
    proc.initialize(env.keys.agy)
    meta = a4_meta(A4_SUB, A4_ROOT, "../../etc/passwd")
    assert not proc.call(env.keys.agy, "a2a_inbox", meta=meta).is_error
    (link,) = run(_links(env))
    assert link.parent_conversation_id is None and link.root_conversation_id == A4_ROOT


def test_a_subagent_conversation_registered_through_sessions_returns_its_roots_handle(env):
    proc = env.client()
    proc.initialize(env.keys.agy)
    h_root = proc.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=a4_meta(A4_SUB, A4_ROOT, A4_ROOT)).data["handle"]
    r = register(env.client(), env.keys.agy, A4_SUB, card=CARD_AGY, name_hint="sub")
    assert r.status_code == 200 and r.json()["handle"] == h_root and r.json()["created"] is False
    assert r.json()["aliases"] == []  # no alias for a sub-invocation
    assert len(env.session_rows()) == 1


def test_clear_in_agy_is_a_new_conversation_and_a_new_handle(env):
    c = env.client()
    old = register(c, env.keys.agy, HSID, card=CARD_AGY, name_hint="work").json()["handle"]
    new = register(c, env.keys.agy, HSID2, card=CARD_AGY, name_hint="work").json()["handle"]
    assert old != new
    mcp = env.client()
    mcp.initialize(env.keys.agy)
    assert mcp.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=agy_meta(HSID)).data["handle"] == old  # the old one stays addressable
    assert mcp.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=agy_meta(HSID2)).data["handle"] == new




# `_meta` is read only for the key's own card, and only for a local-harness key ---------------------


def test_a_remote_peer_with_a_crafted_meta_is_never_interpreted(env):
    """Acceptance: a remote-peer request with a crafted `_meta` is never interpreted."""
    c = env.client()
    meta = a4_meta(A4_ROOT, A4_ROOT)
    for token in (env.keys.peer, env.keys.status):
        reply = c.raw(
            token,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "a2a_inbox", "arguments": {}, "_meta": meta}},
            session="deadbeef",
        )
        assert reply.status_code == 403
    assert env.session_rows() == [] and env.audit_rows("session_registered") == []
    # The same refusal on /sessions, with the id in the body.
    assert register(c, env.keys.peer, A4_ROOT, card=CARD_AGY).status_code == 403
    assert env.session_rows() == []


def test_meta_is_read_only_for_a_local_harness_key_of_an_agy_card():
    mcp_tools = McpTools.__dict__["_conversation"]

    class Ctx:
        def __init__(self, principal, meta):
            self.principal, self.meta = principal, meta

    meta = a4_meta(A4_ROOT, A4_ROOT)
    local_agy = Principal(key_id="aaaaaaaa", scope="local-harness", name="n", card_id=CARD_AGY)
    local_claude = Principal(key_id="aaaaaaab", scope="local-harness", name="n", card_id=CARD_CLAUDE)
    peer_with_agy_card = Principal(key_id="aaaaaaac", scope=REMOTE_PEER, name="n", card_id=CARD_AGY, peer_id="p")
    status_key = Principal(key_id="aaaaaaad", scope="status-client", name="n")
    assert mcp_tools(None, Ctx(local_agy, meta)) == (A4_ROOT, A4_ROOT, None)
    assert mcp_tools(None, Ctx(local_agy, a4_meta(A4_SUB, A4_ROOT, A4_ROOT))) == (A4_SUB, A4_ROOT, A4_ROOT)
    for principal in (local_claude, peer_with_agy_card, status_key):
        assert mcp_tools(None, Ctx(principal, meta)) == (None, None, None)


def test_an_agy_id_registered_under_another_card_is_never_matched_through_sessions(env):
    c = env.client()
    claude_handle = register(c, env.keys.claude, HSID).json()["handle"]
    agy_handle = register(c, env.keys.agy, HSID, card=CARD_AGY).json()["handle"]  # the same id string, another card
    assert claude_handle.startswith(CARD_CLAUDE) and agy_handle.startswith(CARD_AGY) and len(env.session_rows()) == 2
    mcp = env.client()
    mcp.initialize(env.keys.agy)
    assert mcp.call(env.keys.agy, "a2a_hello", {"name": "x"}, meta=agy_meta(HSID)).data["handle"] == agy_handle


def test_conversation_ids_are_read_only_inside_the_identity_and_mcp_packages():
    """A static pin: no other module interprets the agy `_meta` keys."""
    from pathlib import Path

    import coordination

    root = Path(coordination.__file__).parent
    offenders = []
    for path in root.rglob("*.py"):
        rel = path.relative_to(root)
        if rel.parts[0] in {"identity", "mcp"}:
            continue
        if "antigravity.google" in path.read_text():
            offenders.append(str(rel))
    assert offenders == []


# the new tables ----------------------------------------------------------------------------------


def test_alias_and_link_tables_hold_no_content_columns(env):
    async def columns():
        async with env.engine.connect() as conn:
            return await conn.run_sync(
                lambda c: {t: {col["name"] for col in sa.inspect(c).get_columns(t)} for t in ("session_aliases", "session_conversations")}
            )

    cols = run(columns())
    assert cols["session_aliases"] == {"handle", "alias", "card_id", "created_at"}
    assert cols["session_conversations"] == {
        "card_id", "conversation_id", "handle", "root_conversation_id", "parent_conversation_id", "first_seen_at",
    }
    assert session_aliases.name == "session_aliases"


def test_the_touch_of_a_tool_call_makes_a_session_active_and_the_idle_ttl_ends_it(env):
    c = env.client()
    handle = register(c, env.keys.claude, name_hint="idle").json()["handle"]
    env.clock.advance(minutes=20)
    assert listing(c, env.keys.claude).json()["sessions"][0]["liveness"] == "registered"
    mcp = env.client()
    mcp.initialize(env.keys.claude)
    mcp.call(env.keys.claude, "a2a_hello", {"handle": handle})  # an authenticated call from the session
    assert listing(c, env.keys.claude).json()["sessions"][0]["liveness"] == "active"
    env.clock.advance(hours=env.config.session_idle_ttl_h, minutes=1)
    assert run(env.service.sweep()).sessions_ended == 1  # the service layer's idle expiry (S1-STATE)
    assert listing(c, env.keys.claude).json()["sessions"] == []  # live only by default (Z17)
    assert listing(c, env.keys.claude, include_ended="1").json()["sessions"][0]["liveness"] == "ended"
    assert timedelta(hours=env.config.session_idle_ttl_h) > timedelta(minutes=15)
