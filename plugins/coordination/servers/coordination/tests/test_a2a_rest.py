"""The REST (`HTTP+JSON`) binding under `/a2a/v1`, operation by operation (S1-A2A, spec 3.3, 3.3.1).

Both route forms are exercised: plain (`/a2a/v1/tasks/{id}`) and tenant-prefixed
(`/a2a/v1/{tenant}/tasks/{id}`, the tenant being a card id with an `@`). Wire shapes are the SDK
1.3.0's (`a2a.server.routes.rest_dispatcher`, `a2a.utils.error_handlers`); error bodies are
`{"error": {"code", "status", "message", "details": [ErrorInfo]}}`.
"""

from __future__ import annotations

import json

import pytest
from a2a_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    H_CLAUDE,
    SENT,
    local_caller,
    make_a2a_env,
    send_params,
    text_message,
)
from conftest import run

SUBMITTED = "TASK_STATE_SUBMITTED"


@pytest.fixture
def env(pg_db):
    return make_a2a_env(pg_db)


def reason(response) -> str:
    return response.json()["error"]["details"][0]["reason"]


def send(wire, token, tenant_in_path=True, **kw):
    body = {"message": text_message(**kw), "configuration": {"returnImmediately": True}}
    if tenant_in_path:
        return wire.rest(token, "POST", f"/{CARD_CLAUDE}/message:send", json_body=body)
    body["tenant"] = CARD_CLAUDE
    return wire.rest(token, "POST", "/message:send", json_body=body)


# -- version and auth -----------------------------------------------------------------------------


@pytest.mark.parametrize("version", [None, "0.3", "1.1"])
def test_a_missing_or_wrong_version_is_refused_before_the_body_is_read(env, version):
    wire = env.wire()
    for method, path in (("POST", "/message:send"), ("GET", "/tasks"), ("GET", "/tasks/x"), ("POST", "/tasks/x:cancel"), ("GET", "/extendedAgentCard")):
        response = wire.rest(env.keys.agy, method, path, version=version, json_body=None)
        assert response.status_code == 400, (path, response.text[:200])
        assert reason(response) == "VERSION_NOT_SUPPORTED" and "A2A-Version: 1.0" in response.json()["error"]["message"]


def test_the_key_checks_come_first(env):
    wire = env.wire()
    assert wire.rest(None, "GET", "/tasks").status_code == 401
    assert wire.rest(env.keys.status, "GET", "/tasks").status_code == 403
    assert wire.rest(env.keys.agy, "GET", "/tasks").status_code == 200


# -- SendMessage ----------------------------------------------------------------------------------


def test_send_message_with_the_tenant_in_the_path_and_in_the_body(env):
    wire = env.wire()
    for in_path in (True, False):
        response = send(wire, env.keys.agy, in_path, message_id=f"rest-{in_path}")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/a2a+json")
        task = response.json()["task"]
        assert task["status"]["state"] == SUBMITTED and task["history"][0]["parts"][0]["text"] == SENT
    assert wire.rest(env.keys.agy, "GET", "/tasks").json()["totalSize"] == 2


def test_a_conflicting_tenant_in_path_and_body_is_invalid_params(env):
    wire = env.wire()
    body = {"tenant": CARD_AGY, "message": text_message()}
    response = wire.rest(env.keys.agy, "POST", f"/{CARD_CLAUDE}/message:send", json_body=body)
    assert response.status_code == 400 and reason(response) == "INVALID_PARAMS"


def test_a_message_to_the_front_desk_is_refused_with_the_member_card_path(env):
    wire = env.wire()
    for token in (env.keys.agy, env.keys.peer):
        response = wire.rest(token, "POST", "/message:send", json_body={"message": text_message()})
        assert response.status_code == 400 and reason(response) == "INVALID_PARAMS"
        error = response.json()["error"]
        assert "/agents/<card-id>/.well-known/agent-card.json" in error["message"]
        assert error["details"][0]["metadata"]["memberCardPath"] == "/agents/{card-id}/.well-known/agent-card.json"
        assert CARD_CLAUDE not in response.text


def test_a_peer_gets_held_tasks_403_outside_its_allowlist_and_429_when_too_fast(env):
    wire = env.wire()
    held = send(wire, env.keys.peer, message_id="p-1").json()["task"]
    assert held["status"]["state"] == "TASK_STATE_INPUT_REQUIRED" and held["metadata"]["coord"]["hold"] == "quarantine"
    outside = wire.rest(env.keys.peer, "POST", f"/{CARD_AGY}/message:send", json_body={"message": text_message()})
    unknown = wire.rest(env.keys.peer, "POST", "/nobody@nowhere/message:send", json_body={"message": text_message()})
    assert outside.status_code == unknown.status_code == 403
    assert outside.json() == unknown.json() and reason(outside) == "CARD_NOT_ALLOWED"
    codes = [send(wire, env.keys.peer, message_id=f"pr-{i}").status_code for i in range(11)]
    assert codes.count(429) >= 1
    limited = send(wire, env.keys.peer, message_id="pr-last")
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) >= 1 and reason(limited) == "QUOTA_EXCEEDED"


def test_a_bad_or_empty_body_is_invalid_params(env):
    wire = env.wire()
    h = wire.headers(env.keys.agy)
    for body in (b"", b"{", b'{"message": "not a message"}', b"[]"):
        response = wire.http.post(f"/a2a/v1/{CARD_CLAUDE}/message:send", content=body, headers=h)
        assert response.status_code == 400 and reason(response) == "INVALID_PARAMS", body


def test_both_json_content_types_are_accepted_for_the_request_body(env):
    wire = env.wire()
    for n, content_type in enumerate(("application/json", "application/a2a+json", "application/json; charset=utf-8")):
        h = {**wire.headers(env.keys.agy), "Content-Type": content_type}
        body = json.dumps({"message": text_message(message_id=f"ct-{n}"), "configuration": {"returnImmediately": True}})
        assert wire.http.post(f"/a2a/v1/{CARD_CLAUDE}/message:send", content=body, headers=h).status_code == 200


def test_message_parts_media_types_and_limits_over_rest(env):
    wire = env.wire()

    def post(*parts):
        body = {"message": {"messageId": f"m-{len(parts)}-{hash(json.dumps(parts))}", "role": "ROLE_USER", "parts": list(parts)}, "configuration": {"returnImmediately": True}}
        return wire.rest(env.keys.agy, "POST", f"/{CARD_CLAUDE}/message:send", json_body=body)

    assert post({"text": "a", "mediaType": "text/plain"}).status_code == 200
    assert post({"data": {"a": 1}, "mediaType": "application/json"}).status_code == 200
    assert reason(post({"text": "a", "mediaType": "text/markdown"})) == "CONTENT_TYPE_NOT_SUPPORTED"
    assert post({"text": "a"}, *[{"text": "b"}] * 8).status_code == 400  # nine parts
    assert post({"text": "x" * 32769}).status_code == 400


def test_a_repeated_message_id_returns_the_existing_task(env):
    wire = env.wire()
    a = send(wire, env.keys.agy, message_id="same").json()["task"]
    b = send(wire, env.keys.agy, message_id="same", text="other").json()["task"]
    assert a["id"] == b["id"] and wire.rest(env.keys.agy, "GET", "/tasks").json()["totalSize"] == 1


def test_a_blocking_send_over_rest_waits_the_cap_then_returns_the_submitted_task(pg_db):
    env = make_a2a_env(pg_db, send_block_max_s=2)
    wire = env.wire()
    response = wire.rest(env.keys.agy, "POST", f"/{CARD_CLAUDE}/message:send", json_body={"message": text_message()})
    assert response.status_code == 200 and response.json()["task"]["status"]["state"] == SUBMITTED
    assert sum(env.sleeps) == 2.0


# -- reads and cancel -----------------------------------------------------------------------------


def test_get_task_plain_and_tenant_prefixed_with_history_length(env):
    wire = env.wire()
    task = send(wire, env.keys.agy).json()["task"]
    for path in (f"/tasks/{task['id']}", f"/{CARD_CLAUDE}/tasks/{task['id']}"):
        got = wire.rest(env.keys.agy, "GET", path)
        assert got.status_code == 200 and got.json()["id"] == task["id"] and len(got.json()["history"]) == 1
    assert "history" not in wire.rest(env.keys.agy, "GET", f"/tasks/{task['id']}", params={"historyLength": 0}).json()
    assert wire.rest(env.keys.claude, "GET", f"/tasks/{task['id']}").status_code == 200  # the recipient
    missing = wire.rest(env.keys.mac, "GET", f"/tasks/{task['id']}")  # a stranger
    assert missing.status_code == 404 and reason(missing) == "TASK_NOT_FOUND"
    assert wire.rest(env.keys.agy, "GET", "/tasks/not-there").status_code == 404
    assert wire.rest(env.keys.agy, "GET", f"/tasks/{task['id']}", params={"historyLength": "x"}).status_code == 400


def test_list_tasks_query_parameters(env):
    wire = env.wire()
    ids = {send(wire, env.keys.agy, message_id=f"q-{i}").json()["task"]["id"] for i in range(3)}
    listed = wire.rest(env.keys.agy, "GET", "/tasks").json()
    assert listed["totalSize"] == 3 and {t["id"] for t in listed["tasks"]} == ids and listed["pageSize"] == 50
    page = wire.rest(env.keys.agy, "GET", "/tasks", params={"pageSize": 2}).json()
    assert len(page["tasks"]) == 2 and page["nextPageToken"]
    rest = wire.rest(env.keys.agy, "GET", "/tasks", params={"pageSize": 2, "pageToken": page["nextPageToken"]}).json()
    assert len(rest["tasks"]) == 1
    assert wire.rest(env.keys.agy, "GET", "/tasks", params={"status": "TASK_STATE_SUBMITTED"}).json()["totalSize"] == 3
    assert wire.rest(env.keys.agy, "GET", "/tasks", params={"status": "TASK_STATE_WORKING"}).json()["tasks"] == []
    assert wire.rest(env.keys.agy, "GET", "/tasks", params={"pageSize": 101}).status_code == 400
    assert wire.rest(env.keys.agy, "GET", f"/{CARD_CLAUDE}/tasks").status_code == 200  # tenant-prefixed
    assert wire.rest(env.keys.peer, "GET", f"/{CARD_AGY}/tasks").status_code == 403  # outside a peer's allowlist
    assert wire.rest(env.keys.mac, "GET", "/tasks").json()["totalSize"] == 0


def test_cancel_task(env):
    wire = env.wire()
    task = send(wire, env.keys.agy).json()["task"]
    denied = wire.rest(env.keys.claude, "POST", f"/tasks/{task['id']}:cancel")  # the recipient
    assert denied.status_code == 403 and reason(denied) == "FORBIDDEN"
    assert wire.rest(env.keys.mac, "POST", f"/tasks/{task['id']}:cancel").status_code == 404
    done = wire.rest(env.keys.agy, "POST", f"/{CARD_CLAUDE}/tasks/{task['id']}:cancel")
    assert done.status_code == 200 and done.json()["status"]["state"] == "TASK_STATE_CANCELED"
    again = wire.rest(env.keys.agy, "POST", f"/tasks/{task['id']}:cancel")
    assert again.status_code == 400 and reason(again) == "TASK_NOT_CANCELABLE"
    assert wire.rest(env.keys.agy, "POST", "/tasks/missing:cancel").status_code == 404


def test_cancel_of_a_completed_task_is_not_cancelable(env):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    task = send(wire, env.keys.agy).json()["task"]
    run(env.base.service.respond(local_caller(CARD_CLAUDE, H_CLAUDE), task["id"], "completed", text="done"))
    assert reason(wire.rest(env.keys.agy, "POST", f"/tasks/{task['id']}:cancel")) == "TASK_NOT_CANCELABLE"


# -- unsupported at S1 ----------------------------------------------------------------------------


def test_streaming_routes_answer_unsupported_operation(env):
    wire = env.wire()
    task = send(wire, env.keys.agy).json()["task"]
    calls = [
        ("POST", "/message:stream", {"message": text_message()}),
        ("POST", f"/{CARD_CLAUDE}/message:stream", {"message": text_message()}),
        ("GET", f"/tasks/{task['id']}:subscribe", None),
        ("POST", f"/tasks/{task['id']}:subscribe", None),
        ("GET", f"/{CARD_CLAUDE}/tasks/{task['id']}:subscribe", None),
    ]
    for method, path, body in calls:
        response = wire.rest(env.keys.agy, method, path, json_body=body)
        assert response.status_code == 400 and reason(response) == "UNSUPPORTED_OPERATION", (method, path)
        assert response.headers["content-type"].startswith("application/a2a+json")  # an error, not an event stream
    assert wire.rest(env.keys.agy, "GET", "/tasks").json()["totalSize"] == 1


def test_the_four_push_routes_answer_push_not_supported_while_push_is_off(env):
    wire = env.wire()
    base = "/tasks/some-task/pushNotificationConfigs"
    calls = [
        ("POST", base, {"url": "https://example.com/hook"}),
        ("GET", base, None),
        ("GET", base + "/cfg", None),
        ("DELETE", base + "/cfg", None),
        ("POST", f"/{CARD_CLAUDE}" + base, {"url": "https://example.com/hook"}),
    ]
    for method, path, body in calls:
        response = wire.rest(env.keys.agy, method, path, json_body=body)
        assert response.status_code == 400 and reason(response) == "PUSH_NOTIFICATION_NOT_SUPPORTED", (method, path)


# -- extended card --------------------------------------------------------------------------------


def test_extended_card_over_rest(env):
    wire = env.wire()
    env.base.add_session(H_CLAUDE)
    local = wire.rest(env.keys.agy, "GET", f"/{CARD_CLAUDE}/extendedAgentCard")
    assert local.status_code == 200 and local.json()["name"] == CARD_CLAUDE
    assert local.json()["capabilities"]["extensions"][0]["params"]["sessions"][0]["handle"] == H_CLAUDE
    peer = wire.rest(env.keys.peer, "GET", f"/{CARD_CLAUDE}/extendedAgentCard")
    assert peer.status_code == 200 and "params" not in peer.json()["capabilities"]["extensions"][0]
    front = wire.rest(env.keys.agy, "GET", "/extendedAgentCard")
    assert front.status_code == 400 and "front desk" in front.json()["error"]["message"]
    assert wire.rest(env.keys.peer, "GET", f"/{CARD_AGY}/extendedAgentCard").status_code == 403


# -- routing --------------------------------------------------------------------------------------


def test_unknown_paths_and_wrong_methods(env):
    wire = env.wire()
    assert wire.rest(env.keys.agy, "GET", "/nothing/here/at/all").status_code == 404
    assert wire.rest(env.keys.agy, "PUT", "/tasks").status_code == 405
    assert wire.rest(env.keys.agy, "DELETE", "/tasks/x").status_code == 405
    assert wire.rest(env.keys.agy, "GET", "/message:send").status_code == 405


def test_every_rest_error_is_application_a2a_json(env):
    """A2A 1.0.1 section 11.1 and the 11.6 error example: `application/a2a+json` for responses,
    errors included (Z16 review, 2026-11-16; the TCK's HTTP_JSON-SVC-001 checks it)."""
    wire = env.wire()
    errors = [
        wire.rest(env.keys.agy, "GET", "/tasks", version="0.3"),  # VERSION_NOT_SUPPORTED
        wire.rest(env.keys.agy, "POST", "/message:send", json_body={"message": {}}),  # InvalidParams
        wire.rest(env.keys.agy, "GET", "/tasks/no-such-task"),  # TaskNotFound
        wire.rest(env.keys.agy, "POST", "/message:stream", json_body={"message": text_message()}),  # unsupported
    ]
    for response in errors:
        assert response.status_code >= 400, response.text[:200]
        assert response.headers["content-type"].startswith("application/a2a+json"), response.status_code
        assert "error" in response.json()


def test_errors_are_never_cached_and_carry_no_internal_detail(env, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("SECRET-DETAIL-do-not-leak")

    monkeypatch.setattr(env.base.service, "get_task", boom)
    response = env.wire().rest(env.keys.agy, "GET", "/tasks/x")
    assert response.status_code == 500 and reason(response) == "INTERNAL_ERROR"
    assert "SECRET-DETAIL" not in response.text and response.headers["cache-control"] == "no-store"
