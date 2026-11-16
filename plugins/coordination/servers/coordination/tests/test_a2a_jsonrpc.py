"""`POST /a2a/v1`, the JSON-RPC binding, operation by operation (S1-A2A, spec 3.3, 3.3.1, 3.3.2).

The real app: the real access-control middleware over the SQL key store, the real service layer and
a real Postgres. The wire shapes (ProtoJSON, error codes, the ErrorInfo detail) are those of the
SDK 1.3.0 (`a2a.utils.errors`, `a2a.types`), which implements the pinned spec; see the caveat in
docs/specs/a2a.md about what could not be checked against the spec text.
"""

from __future__ import annotations

import json
import time

import pytest
from a2a_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    H_AGY,
    H_CLAUDE,
    SENT,
    local_caller,
    make_a2a_env,
    peer_caller,
    send_params,
    text_message,
)
from conftest import run

from coordination.a2a.errors import CARD_NOT_ALLOWED_CODE, FORBIDDEN_CODE, QUOTA_EXCEEDED_CODE

WORKING, SUBMITTED = "TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"


@pytest.fixture
def env(pg_db):
    return make_a2a_env(pg_db)


def state(task: dict) -> str:
    return task["status"]["state"]


# -- envelope, version, closed method set ---------------------------------------------------------


@pytest.mark.parametrize("version", [None, "", "0.3", "0.3.0", "1.1", "2.0", "latest"])
def test_a_missing_or_wrong_a2a_version_is_32009_with_a_message_that_says_to_send_1_0(env, version):
    wire = env.wire()
    err = wire.error(env.keys.claude, "GetTask", {"id": "x"}, version=version)
    assert err["code"] == -32009
    assert "A2A-Version: 1.0" in err["message"]
    info = err["data"][0]
    assert info["reason"] == "VERSION_NOT_SUPPORTED" and info["metadata"]["supported"] == "1.0"


@pytest.mark.parametrize("version", ["1.0", "1.0.1"])
def test_version_1_0_and_a_patch_level_are_served(env, version):
    err = env.wire().error(env.keys.claude, "GetTask", {"id": "nope"}, version=version)
    assert err["code"] == -32001  # got as far as the task lookup


def test_the_version_is_checked_before_the_method_so_a_v03_client_is_told_about_the_version(env):
    wire = env.wire()
    err = wire.error(env.keys.claude, "message/send", {}, version=None)
    assert err["code"] == -32009
    assert wire.error(env.keys.claude, "message/send", {})["code"] == -32601  # with 1.0 it is just an unknown method


def test_the_method_set_is_closed_to_the_eleven_operations(env):
    wire = env.wire()
    for method in ("tasks/get", "Foo", "a2a_request", "SendMessage ", "sendmessage", "rpc.discover", ""):
        assert wire.error(env.keys.claude, method, {})["code"] in (-32601, -32600), method


def test_envelope_errors(env):
    wire = env.wire()
    token = env.keys.claude
    assert wire.rpc_raw(token, b"{not json").json()["error"]["code"] == -32700
    assert wire.rpc_raw(token, b"\xff\xfe").json()["error"]["code"] == -32700
    assert wire.rpc_raw(token, [{"jsonrpc": "2.0", "id": 1, "method": "GetTask"}]).json()["error"]["code"] == -32600  # no batches
    assert wire.rpc_raw(token, {"jsonrpc": "1.0", "id": 1, "method": "GetTask"}).json()["error"]["code"] == -32600
    assert wire.rpc_raw(token, {"jsonrpc": "2.0", "id": True, "method": "GetTask"}).json()["error"]["code"] == -32600
    assert wire.rpc_raw(token, {"jsonrpc": "2.0", "id": 1}).json()["error"]["code"] == -32600
    assert wire.error(token, "GetTask", None)["code"] == -32602  # `id` missing
    bad = wire.rpc_raw(token, {"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": [1]}).json()
    assert bad["error"]["code"] == -32602 and bad["id"] == 1
    mismatch = wire.rpc_raw(token, {"jsonrpc": "2.0", "id": 2, "method": "ListTasks", "params": {"pageSize": "many"}}).json()
    assert mismatch["error"]["code"] == -32602


def test_the_response_echoes_the_request_id_and_is_never_cached(env):
    response = env.wire().rpc_raw(env.keys.claude, {"jsonrpc": "2.0", "id": "abc-1", "method": "ListTasks", "params": {}})
    assert response.json()["id"] == "abc-1" and response.json()["jsonrpc"] == "2.0"
    assert response.headers["cache-control"] == "no-store"


def test_no_key_is_401_a_status_client_key_is_403_the_endpoint_is_not_open(env):
    wire = env.wire()
    assert wire.rpc(None, "ListTasks", {}).status_code == 401
    assert wire.rpc(env.keys.status, "ListTasks", {}).status_code == 403
    assert wire.rpc(env.keys.claude, "ListTasks", {}).status_code == 200


def test_an_unexpected_failure_is_a_constant_internal_error_with_nothing_of_the_cause(env, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("SECRET-DETAIL-do-not-leak")

    monkeypatch.setattr(env.base.service, "get_task", boom)
    response = env.wire().rpc(env.keys.claude, "GetTask", {"id": "x"})
    body = response.json()
    assert body["error"]["code"] == -32603 and "SECRET-DETAIL" not in response.text


# -- SendMessage ----------------------------------------------------------------------------------


def test_send_message_by_a_local_key_creates_a_submitted_task(env):
    wire = env.wire()
    result = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))
    task = result["task"]
    assert state(task) == SUBMITTED and task["id"] and task["contextId"]
    assert task["history"][0]["parts"][0]["text"] == SENT and task["history"][0]["role"] == "ROLE_USER"
    coord = task["metadata"]["coord"]
    assert coord["origin"] == "local" and coord["from"] == CARD_AGY and "hold" not in coord


def test_a_repeated_message_id_returns_the_existing_task(env):
    wire = env.wire()
    first = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE, message_id="m-1"))["task"]
    again = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE, "different text", message_id="m-1"))["task"]
    assert again["id"] == first["id"] and again["history"][0]["parts"][0]["text"] == SENT
    listed = wire.result(env.keys.agy, "ListTasks", {})
    assert listed["totalSize"] == 1


def test_a_remote_peer_task_is_held_and_shown_as_input_required_with_a_constant_status(env):
    wire = env.wire()
    task = wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE, "a peer asks"))["task"]
    assert state(task) == "TASK_STATE_INPUT_REQUIRED"
    assert task["metadata"]["coord"]["hold"] == "quarantine" and task["metadata"]["coord"]["origin"] == "remote"
    assert task["status"]["message"]["parts"][0]["text"] == "Held for human review by the recipient. No action needed."
    # the recipient side never sees it until a human releases it
    assert wire.result(env.keys.claude, "ListTasks", {})["totalSize"] == 0
    assert wire.error(env.keys.claude, "GetTask", {"id": task["id"]})["code"] == -32001


def test_a_peer_naming_a_card_outside_its_allowlist_or_one_that_does_not_exist_gets_the_same_403(env):
    wire = env.wire()
    outside = wire.rpc(env.keys.peer, "SendMessage", send_params(CARD_AGY))
    unknown = wire.rpc(env.keys.peer, "SendMessage", send_params("nobody@nowhere"))
    assert outside.status_code == unknown.status_code == 403
    assert outside.json()["error"]["code"] == unknown.json()["error"]["code"] == CARD_NOT_ALLOWED_CODE
    assert outside.json()["error"] == unknown.json()["error"]  # byte-identical: no oracle (X3)
    assert outside.json()["id"] != unknown.json()["id"] or True  # (ids differ per call; bodies otherwise equal)
    assert wire.result(env.keys.peer, "ListTasks", {})["totalSize"] == 0  # not stored as a task


def test_a_message_to_the_front_desk_is_refused_with_a_pointer_to_the_member_card_path(env):
    wire = env.wire()
    for token in (env.keys.claude, env.keys.peer):
        err = wire.error(token, "SendMessage", {"message": text_message(), "configuration": {"returnImmediately": True}})
        assert err["code"] == -32602
        assert "front desk" in err["message"] and "/agents/<card-id>/.well-known/agent-card.json" in err["message"]
        assert err["data"][0]["metadata"]["memberCardPath"] == "/agents/{card-id}/.well-known/agent-card.json"
        assert CARD_CLAUDE not in json.dumps(err) and CARD_AGY not in json.dumps(err)  # it lists no member
    assert wire.result(env.keys.claude, "ListTasks", {})["totalSize"] == 0


def test_metadata_target_is_not_a_routing_input(env):
    """Z13: no routing by `metadata.target`. With no tenant the message is refused whatever it says;
    with a tenant the tenant decides."""
    wire = env.wire()
    params = send_params("", message_id="mt-1")
    params["metadata"] = {"target": CARD_AGY}
    params["message"]["metadata"] = {"target": CARD_AGY}
    assert wire.error(env.keys.agy, "SendMessage", params)["code"] == -32602
    params = send_params(CARD_CLAUDE, message_id="mt-2")
    params["metadata"] = {"target": CARD_AGY}
    task = wire.result(env.keys.agy, "SendMessage", params)["task"]
    index = run(env.base.store.get_index(task["id"]))
    assert index.to_card == CARD_CLAUDE


def test_a_client_cannot_plant_coord_metadata_only_coord_to_is_read(env):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    params = send_params(CARD_CLAUDE, message_id="coord-1")
    params["metadata"] = {"coord": {"to": H_CLAUDE, "origin": "import", "hold": "none", "from": "someone-else"}}
    task = wire.result(env.keys.agy, "SendMessage", params)["task"]
    coord = task["metadata"]["coord"]
    assert coord["origin"] == "local" and coord["from"] == CARD_AGY and "hold" not in coord
    assert run(env.base.store.get_index(task["id"])).to_handle == H_CLAUDE  # coord.to was honoured


def test_the_caller_handle_comes_from_a_live_registered_session_of_the_keys_card_only(env):
    wire = env.wire()
    env.base.add_session(H_AGY)
    env.base.add_session("antigravity@box/old~bbbbbbb9", ended=True)

    def sent(handle):
        task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE), extra={"X-Coord-Handle": handle} if handle else None)["task"]
        return task["metadata"]["coord"]["from"]

    assert sent(H_AGY) == H_AGY  # registered, live, same card
    assert sent(None) == CARD_AGY
    assert sent("antigravity@box/old~bbbbbbb9") == CARD_AGY  # ended: ignored
    assert sent("antigravity@box/nope~bbbbbbb8") == CARD_AGY  # not registered: ignored
    assert sent("claude-code@box/one~aaaaaaa1") == CARD_AGY  # another card's handle: ignored
    assert sent("not a handle") == CARD_AGY
    # a peer's header is never read
    env.base.add_session(H_CLAUDE)
    task = wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE), extra={"X-Coord-Handle": H_CLAUDE})["task"]
    assert task["metadata"]["coord"]["from"] == "peer:peer1"


def test_limits_eight_parts_32_kib_per_text_part_and_the_content_types(env):
    wire = env.wire()
    token = env.keys.agy

    def parts(*p):
        return {"tenant": CARD_CLAUDE, "configuration": {"returnImmediately": True},
                "message": {"messageId": f"lim-{len(json.dumps(p))}-{hash(json.dumps(p))}", "role": "ROLE_USER", "parts": list(p)}}

    text = {"text": "x"}
    assert state(wire.result(token, "SendMessage", parts(*[text] * 8))["task"]) == SUBMITTED
    assert wire.error(token, "SendMessage", parts(*[text] * 9))["code"] == -32602
    assert wire.error(token, "SendMessage", parts())["code"] == -32602
    ok = wire.result(token, "SendMessage", parts({"text": "a" * 32768}))
    assert state(ok["task"]) == SUBMITTED
    assert wire.error(token, "SendMessage", parts({"text": "a" * 32769}))["code"] == -32602
    assert state(wire.result(token, "SendMessage", parts({"text": "plain", "mediaType": "text/plain"}))["task"]) == SUBMITTED
    assert state(wire.result(token, "SendMessage", parts({"data": {"k": "v"}, "mediaType": "application/json"}))["task"]) == SUBMITTED
    for bad in ({"text": "x", "mediaType": "text/html"}, {"text": "x", "mediaType": "image/png"}, {"raw": "AAAA", "mediaType": "image/png"}, {"url": "https://example.com/f"}):
        assert wire.error(token, "SendMessage", parts(bad))["code"] == -32005, bad


def test_a_task_keeps_at_most_200_history_messages(env):
    wire = env.wire()
    sender = local_caller(CARD_AGY)
    task = run(env.base.service.send_message(sender, CARD_CLAUDE, _msg("first")))
    for i in range(199):
        run(env.base.service.send_message(sender, CARD_CLAUDE, _msg(f"more {i}", task_id=task.id)))
    assert len(run(env.base.service.get_task(sender, task.id)).history) == 200
    err = wire.error(env.keys.agy, "SendMessage", {"tenant": CARD_CLAUDE, "message": text_message("one too many", task_id=task.id), "configuration": {"returnImmediately": True}})
    assert err["code"] == -32602 and "200" in err["message"]


def _msg(text, *, task_id=None):
    from a2a.types import a2a_pb2 as pb
    import uuid

    m = pb.Message(message_id=str(uuid.uuid4()), role=pb.Role.ROLE_USER, task_id=task_id or "")
    m.parts.add(text=text)
    return m


def test_a_follow_up_on_a_finished_task_is_32004(env):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    run(env.base.service.respond(local_caller(CARD_CLAUDE, H_CLAUDE), task["id"], "completed", text="done"))
    err = wire.error(env.keys.agy, "SendMessage", {"tenant": CARD_CLAUDE, "message": text_message("more", task_id=task["id"]), "configuration": {"returnImmediately": True}})
    assert err["code"] == -32004


def test_a_peer_that_sends_too_fast_gets_429_with_retry_after(env):
    wire = env.wire()
    codes = [wire.rpc(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE, message_id=f"rate-{i}")).status_code for i in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429
    last = wire.rpc(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE, message_id="rate-x"))
    assert last.json()["error"]["code"] == QUOTA_EXCEEDED_CODE and int(last.headers["retry-after"]) >= 1


def test_send_message_configuration_with_push_while_push_is_off_is_32003(env):
    params = send_params(CARD_CLAUDE)
    params["configuration"]["taskPushNotificationConfig"] = {"url": "https://example.com/hook"}
    err = env.wire().error(env.keys.agy, "SendMessage", params)
    assert err["code"] == -32003
    assert env.wire().result(env.keys.agy, "ListTasks", {})["totalSize"] == 0  # nothing was created


def test_history_length_on_send_message_trims_the_returned_history(env):
    wire = env.wire()
    params = send_params(CARD_CLAUDE)
    params["configuration"]["historyLength"] = 0
    task = wire.result(env.keys.agy, "SendMessage", params)["task"]
    assert "history" not in task


# -- blocking SendMessage (D22) -------------------------------------------------------------------


def blocking(card=CARD_CLAUDE, **kw):
    return send_params(card, immediate=False, **kw)


def test_a_blocking_send_on_a_parked_task_returns_the_submitted_task_after_the_cap_in_virtual_time(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=2)
    task = env.wire().result(env.keys.agy, "SendMessage", blocking())["task"]
    assert state(task) == SUBMITTED
    assert sum(env.sleeps) == 2.0 and len(env.sleeps) == 2  # two polls of 1 s, never past the cap


def test_a_blocking_send_with_a_real_clock_returns_after_about_two_seconds(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=2)
    wire = env.wire(env.app(real_time=True))
    started = time.monotonic()
    task = wire.result(env.keys.agy, "SendMessage", blocking())["task"]
    elapsed = time.monotonic() - started
    assert state(task) == SUBMITTED
    assert 1.8 <= elapsed < 6.0, elapsed


def test_return_immediately_returns_at_once_without_waiting(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=60)
    wire = env.wire(env.app(real_time=True))
    started = time.monotonic()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE, immediate=True))["task"]
    assert state(task) == SUBMITTED and time.monotonic() - started < 1.5
    assert env.sleeps == []


def test_the_default_cap_is_60_seconds(env):
    assert env.config.send_block_max_s == 60
    env.wire().result(env.keys.agy, "SendMessage", blocking())
    assert sum(env.sleeps) == 60.0


def test_a_blocking_send_returns_as_soon_as_the_recipient_finishes(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=30)
    env.base.add_session(H_CLAUDE)
    recipient = local_caller(CARD_CLAUDE, H_CLAUDE)
    seen: list[str] = []

    async def hook(_now):
        if len(env.sleeps) == 3:  # the third poll: the recipient answers
            tasks = await env.base.service.inbox(recipient)
            task_id = tasks.items[0].task.id
            seen.append(task_id)
            await env.base.service.respond(recipient, task_id, "completed", text="the answer")

    env.on_sleep.append(hook)
    task = env.wire().result(env.keys.agy, "SendMessage", blocking())["task"]
    assert state(task) == "TASK_STATE_COMPLETED" and task["id"] == seen[0]
    assert len(env.sleeps) == 3 and sum(env.sleeps) == 3.0  # woke at the first poll that saw it


def test_a_blocking_send_on_a_held_task_returns_at_once_it_is_already_interrupted(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=60)
    task = env.wire().result(env.keys.peer, "SendMessage", blocking())["task"]
    assert state(task) == "TASK_STATE_INPUT_REQUIRED" and env.sleeps == []


def test_a_working_task_keeps_a_blocking_send_waiting_until_the_cap(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=3)
    env.base.add_session(H_CLAUDE)
    recipient = local_caller(CARD_CLAUDE, H_CLAUDE)

    async def hook(_now):
        if len(env.sleeps) == 1:
            items = (await env.base.service.inbox(recipient)).items
            await env.base.service.respond(recipient, items[0].task.id, "working")

    env.on_sleep.append(hook)
    task = env.wire().result(env.keys.agy, "SendMessage", blocking())["task"]
    assert state(task) == WORKING and sum(env.sleeps) == 3.0


# -- GetTask, ListTasks, CancelTask ---------------------------------------------------------------


def test_get_task_by_originator_and_recipient_not_by_a_stranger(env):
    wire = env.wire()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    for token in (env.keys.agy, env.keys.claude, env.keys.claude_other):
        got = wire.result(token, "GetTask", {"id": task["id"]})
        assert got["id"] == task["id"] and state(got) == SUBMITTED
    assert wire.error(env.keys.mac, "GetTask", {"id": task["id"]})["code"] == -32001
    assert wire.error(env.keys.peer, "GetTask", {"id": task["id"]})["code"] == -32001
    assert wire.error(env.keys.agy, "GetTask", {"id": "no-such-task"})["code"] == -32001


def test_a_stranger_and_a_missing_task_are_indistinguishable(env):
    wire = env.wire()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    stranger = wire.error(env.keys.mac, "GetTask", {"id": task["id"]})
    missing = wire.error(env.keys.mac, "GetTask", {"id": "00000000-0000-0000-0000-000000000000"})
    assert stranger == missing  # the same error, byte for byte: nothing tells "not yours" from "not there"


def test_get_task_history_length(env):
    wire = env.wire()
    sender = local_caller(CARD_AGY)
    task = run(env.base.service.send_message(sender, CARD_CLAUDE, _msg("one")))
    for i in range(3):
        run(env.base.service.send_message(sender, CARD_CLAUDE, _msg(f"more {i}", task_id=task.id)))
    full = wire.result(env.keys.agy, "GetTask", {"id": task.id})
    assert len(full["history"]) == 4
    assert len(wire.result(env.keys.agy, "GetTask", {"id": task.id, "historyLength": 2})["history"]) == 2
    assert "history" not in wire.result(env.keys.agy, "GetTask", {"id": task.id, "historyLength": 0})
    assert wire.error(env.keys.agy, "GetTask", {"id": task.id, "historyLength": -1})["code"] == -32602


def test_list_tasks_filters_pages_and_shows_only_what_the_caller_may_see(env):
    wire = env.wire()
    ids = [wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE, message_id=f"l-{i}"))["task"]["id"] for i in range(3)]
    wire.result(env.keys.mac, "SendMessage", send_params("claude-code@mac", message_id="other"))  # someone else's
    wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE, message_id="peer-1"))  # held
    listed = wire.result(env.keys.agy, "ListTasks", {})
    assert listed["totalSize"] == 3 and {t["id"] for t in listed["tasks"]} == set(ids)
    assert wire.result(env.keys.claude, "ListTasks", {})["totalSize"] == 3  # recipient side: not the held one
    assert wire.result(env.keys.peer, "ListTasks", {})["totalSize"] == 1  # a peer: only its own
    assert wire.result(env.keys.mac, "ListTasks", {"status": "TASK_STATE_SUBMITTED"})["totalSize"] == 1
    assert wire.result(env.keys.agy, "ListTasks", {"status": "TASK_STATE_COMPLETED"})["tasks"] == []
    ctx = listed["tasks"][0]["contextId"]
    assert [t["id"] for t in wire.result(env.keys.agy, "ListTasks", {"contextId": ctx})["tasks"]] == [listed["tasks"][0]["id"]]

    page1 = wire.result(env.keys.agy, "ListTasks", {"pageSize": 2})
    assert len(page1["tasks"]) == 2 and page1["nextPageToken"] and page1["pageSize"] == 2
    page2 = wire.result(env.keys.agy, "ListTasks", {"pageSize": 2, "pageToken": page1["nextPageToken"]})
    assert len(page2["tasks"]) == 1 and not page2.get("nextPageToken")
    assert {t["id"] for t in page1["tasks"] + page2["tasks"]} == set(ids)
    assert wire.error(env.keys.agy, "ListTasks", {"pageSize": 101})["code"] == -32602  # maximum 100
    assert wire.error(env.keys.agy, "ListTasks", {"pageSize": 0})["code"] == -32602
    assert wire.error(env.keys.agy, "ListTasks", {"pageToken": "garbage"})["code"] == -32602
    default = wire.result(env.keys.agy, "ListTasks", {})
    assert default["pageSize"] == 50  # the default


def test_list_tasks_history_length_and_artifacts(env):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    recipient = local_caller(CARD_CLAUDE, H_CLAUDE)
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    run(env.base.service.respond(recipient, task["id"], "completed", text="done", artifacts=[{"name": "out", "text": "result"}]))
    with_all = wire.result(env.keys.agy, "ListTasks", {"includeArtifacts": True})["tasks"][0]
    assert with_all["artifacts"][0]["name"] == "out" and len(with_all["history"]) == 2
    default = wire.result(env.keys.agy, "ListTasks", {})["tasks"][0]
    assert "artifacts" not in default  # includeArtifacts defaults to false
    assert "history" not in wire.result(env.keys.agy, "ListTasks", {"historyLength": 0})["tasks"][0]


def test_cancel_task_by_the_originator_only_and_not_twice(env):
    wire = env.wire()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    err = wire.rpc(env.keys.claude, "CancelTask", {"id": task["id"]})  # the recipient: visible, not theirs
    assert err.status_code == 403 and err.json()["error"]["code"] == FORBIDDEN_CODE
    assert wire.error(env.keys.mac, "CancelTask", {"id": task["id"]})["code"] == -32001  # a stranger
    canceled = wire.result(env.keys.agy, "CancelTask", {"id": task["id"]})
    assert state(canceled) == "TASK_STATE_CANCELED" and canceled["id"] == task["id"]
    assert wire.error(env.keys.agy, "CancelTask", {"id": task["id"]})["code"] == -32002  # already terminal
    assert wire.error(env.keys.agy, "CancelTask", {"id": "missing"})["code"] == -32001
    assert wire.error(env.keys.agy, "CancelTask", {})["code"] == -32602


@pytest.mark.parametrize("terminal", ["completed", "failed", "rejected"])
def test_a_task_in_any_terminal_state_is_not_cancelable_32002(env, terminal):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    run(env.base.service.respond(local_caller(CARD_CLAUDE, H_CLAUDE), task["id"], terminal, text="x"))
    assert wire.error(env.keys.agy, "CancelTask", {"id": task["id"]})["code"] == -32002


def test_a_peer_cancels_its_own_held_task(env):
    wire = env.wire()
    task = wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE))["task"]
    assert state(wire.result(env.keys.peer, "CancelTask", {"id": task["id"]})) == "TASK_STATE_CANCELED"


# -- tenants on the other operations --------------------------------------------------------------


def test_a_tenant_on_a_read_must_be_a_defined_card_and_inside_a_peers_allowlist(env):
    wire = env.wire()
    task = wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE))["task"]
    assert wire.result(env.keys.peer, "GetTask", {"id": task["id"], "tenant": CARD_CLAUDE})["id"] == task["id"]
    out = wire.rpc(env.keys.peer, "GetTask", {"id": task["id"], "tenant": CARD_AGY})
    unknown = wire.rpc(env.keys.peer, "GetTask", {"id": task["id"], "tenant": "nobody@nowhere"})
    assert out.status_code == unknown.status_code == 403 and out.json()["error"] == unknown.json()["error"]
    assert wire.error(env.keys.agy, "GetTask", {"id": "x", "tenant": "nobody@nowhere"})["code"] == -32602
    assert wire.error(env.keys.agy, "GetTask", {"id": "x", "tenant": "Not A Card"})["code"] == -32602


# -- unsupported at S1 ----------------------------------------------------------------------------


def test_the_two_stream_operations_answer_32004(env):
    wire = env.wire()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    stream = wire.error(env.keys.agy, "SendStreamingMessage", send_params(CARD_CLAUDE))
    sub = wire.error(env.keys.agy, "SubscribeToTask", {"id": task["id"]})
    assert stream["code"] == sub["code"] == -32004
    assert stream["data"][0]["reason"] == "UNSUPPORTED_OPERATION"
    assert wire.result(env.keys.agy, "ListTasks", {})["totalSize"] == 1  # the streaming call created nothing


PUSH_CALLS = [
    ("CreateTaskPushNotificationConfig", {"taskId": "t", "url": "https://example.com/hook"}),
    ("GetTaskPushNotificationConfig", {"taskId": "t", "id": "c"}),
    ("ListTaskPushNotificationConfigs", {"taskId": "t"}),
    ("DeleteTaskPushNotificationConfig", {"taskId": "t", "id": "c"}),
]


@pytest.mark.parametrize("method, params", PUSH_CALLS)
def test_the_four_push_operations_answer_32003_while_push_is_off(env, method, params):
    err = env.wire().error(env.keys.agy, method, params)
    assert err["code"] == -32003 and err["data"][0]["reason"] == "PUSH_NOTIFICATION_NOT_SUPPORTED"


def test_push_answers_32003_before_it_looks_at_the_task_so_it_is_no_oracle(env):
    wire = env.wire()
    task = wire.result(env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]
    a = wire.error(env.keys.mac, "ListTaskPushNotificationConfigs", {"taskId": task["id"]})  # a stranger
    b = wire.error(env.keys.mac, "ListTaskPushNotificationConfigs", {"taskId": "nope"})
    assert a["code"] == b["code"] == -32003
