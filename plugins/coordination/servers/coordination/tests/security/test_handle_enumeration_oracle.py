"""Invariant (api 9, D-H, R1, X3): a remote-peer key gets the same "not available" answer for an unknown
handle, an ended handle and a handle it may not use, and never receives a handle list.

The enumeration-oracle check of the spec, over both A2A bindings on the real app and a real Postgres:
handle guesses are sent with a `remote-peer` key and the answers compared after the per-request ids
(task id, context id, timestamps, message id, JSON-RPC id) are replaced by placeholders.

- In a card the key may use (`cards_allowed`): an unknown handle, an ended handle and the handle of a live
  session of ANOTHER card (addressed through the allowed card) give byte-identical answers. A handle that
  exists and is live there yields a held task; the spec accepts that visibility (2026-11-09).
- In a card the key may not use: a live handle, an unknown handle of that card and a handle of a card that
  does not exist give byte-identical `403 CardNotAllowed` answers.
- No answer to the key, and nothing it can list afterwards, holds a handle it did not itself type.

Out of scope here and deferred to S2-LISTEN, where the guess counter is built: the per-key limit that
trips at the 10th "not available" answer within 60 s, its `429`, its audit row and the card-addressed
exemption. The service names that counter "built with S2-LISTEN"; it does not exist at S1.
"""

from __future__ import annotations

import re

import pytest
from a2a_helpers import CARD_AGY, CARD_CLAUDE, H_AGY, H_CLAUDE, H_CLAUDE2, make_a2a_env
from mcp_helpers import H_MAC

UNKNOWN = f"{CARD_CLAUDE}/nobody~00000000"
ENDED = H_CLAUDE2
GHOST_CARD_HANDLE = "ghost@nowhere/x~00000000"
UNKNOWN_IN_FORBIDDEN_CARD = f"{CARD_AGY}/nobody~00000000"
ALL_HANDLES = (H_CLAUDE, H_CLAUDE2, H_AGY, H_MAC, UNKNOWN, UNKNOWN_IN_FORBIDDEN_CARD, GHOST_CARD_HANDLE)


@pytest.fixture
def env(pg_db):
    env = make_a2a_env(pg_db)  # the peer key may use CARD_CLAUDE only
    env.base.add_session(H_CLAUDE)
    env.base.add_session(ENDED, ended=True)
    env.base.add_session(H_AGY)
    return env


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?")


def normal(text: str, *typed: str) -> str:
    """The body with what differs per request replaced. The handle the key typed is replaced too: an
    answer may not echo it, but if it does, both answers echo their own and still differ only there."""
    for handle in typed:
        text = text.replace(handle, "<TYPED>")
    text = re.sub(r"\"id\":\s*\d+", "\"id\":<N>", text)  # the JSON-RPC request id
    text = re.sub(r"\"messageId\":\"[mr]-\d+\"", "\"messageId\":\"<M>\"", text)
    return _TIME.sub("<T>", _UUID.sub("<ID>", text))


def rpc_send(wire, token, tenant, handle, n):
    params = {
        "tenant": tenant, "configuration": {"returnImmediately": True},
        "message": {"messageId": f"m-{n}", "role": "ROLE_USER", "parts": [{"text": "hello"}], "metadata": {"coord": {"to": handle}}},
    }  # fmt: skip
    return wire.rpc(token, "SendMessage", params)


def rest_send(wire, token, tenant, handle, n):
    body = {
        "configuration": {"returnImmediately": True},
        "message": {"messageId": f"r-{n}", "role": "ROLE_USER", "parts": [{"text": "hello"}], "metadata": {"coord": {"to": handle}}},
    }  # fmt: skip
    return wire.rest(token, "POST", f"/{tenant}/message:send", json_body=body)


BINDINGS = [("jsonrpc", rpc_send), ("rest", rest_send)]


@pytest.mark.parametrize(("binding", "send"), BINDINGS, ids=[b for b, _ in BINDINGS])
def test_unknown_ended_and_other_card_handles_in_an_allowed_card_are_one_answer(env, binding, send):
    wire = env.wire()
    answers = []
    for n, handle in enumerate((UNKNOWN, ENDED, H_AGY, H_MAC)):
        r = send(wire, env.keys.peer, CARD_CLAUDE, handle, n)
        assert handle not in r.text and handle.split("/")[1] not in r.text, handle  # no echo of what was guessed
        answers.append((r.status_code, r.headers["content-type"].split(";")[0], normal(r.text, handle)))
    assert len(set(answers)) == 1, answers
    assert "not available" in answers[0][2].lower()  # a task REJECTED with the constant text
    for handle in (UNKNOWN, ENDED, H_AGY, H_MAC):
        assert handle not in answers[0][2]


@pytest.mark.parametrize(("binding", "send"), BINDINGS, ids=[b for b, _ in BINDINGS])
def test_handles_in_a_card_the_key_may_not_use_are_one_403(env, binding, send):
    wire = env.wire()
    answers = []
    for n, (tenant, handle) in enumerate(
        [(CARD_AGY, H_AGY), (CARD_AGY, UNKNOWN_IN_FORBIDDEN_CARD), ("ghost@nowhere", GHOST_CARD_HANDLE), ("claude-code@mac", H_MAC)]
    ):
        r = send(wire, env.keys.peer, tenant, handle, n)
        assert handle not in r.text and tenant not in r.text, (tenant, handle)  # no echo of what was guessed
        body = normal(r.text, handle, tenant)
        answers.append((r.status_code, r.headers["content-type"].split(";")[0], body))
    assert {a[0] for a in answers} == {403}
    assert len(set(answers)) == 1, answers
    assert not [h for h in ALL_HANDLES if h in answers[0][2]]


def test_a_live_handle_in_an_allowed_card_is_held_and_that_is_the_accepted_visibility(env):
    wire = env.wire()
    r = rpc_send(wire, env.keys.peer, CARD_CLAUDE, H_CLAUDE, 0)
    task = r.json()["result"]["task"]
    assert task["status"]["state"] == "TASK_STATE_INPUT_REQUIRED" and task["metadata"]["coord"]["hold"] == "quarantine"


def test_no_answer_to_the_peer_holds_a_handle_it_did_not_type_and_it_can_list_none(env):
    wire = env.wire()
    typed = [UNKNOWN, ENDED, H_AGY, H_MAC, H_CLAUDE]
    seen = []
    for n, handle in enumerate(typed):
        for send in (rpc_send, rest_send):
            seen.append(send(wire, env.keys.peer, CARD_CLAUDE, handle, n + (100 if send is rest_send else 0)).text)
    seen.append(wire.rpc(env.keys.peer, "ListTasks", {"tenant": CARD_CLAUDE}).text)
    seen.append(wire.rest(env.keys.peer, "GET", "/tasks").text)
    seen.append(wire.rest(env.keys.peer, "GET", "/extendedAgentCard").text)
    for path in ("/.well-known/agent-card.json", f"/agents/{CARD_CLAUDE}/.well-known/agent-card.json", f"/agents/{CARD_AGY}/.well-known/agent-card.json"):
        seen.append(wire.card(path, env.keys.peer).text)
    blob = "\n".join(seen)
    # the only handle that may appear is one the peer typed AND that is live in its card (its own held task)
    for handle in (ENDED, H_AGY, H_MAC, "nobody~00000000"):
        assert handle not in blob, handle
    sid8s = re.findall(r"~[0-9a-f]{7,8}", blob)
    assert set(sid8s) <= {"~aaaaaaa1"}, sid8s  # only the live allowed-card handle it typed, in its own held task
