"""S1-MCP against the real stack: the real access-control middleware over the SQL key store, the
real service layer and a real Postgres. The transport, the scope matrix, sessions and the tool list."""

from __future__ import annotations

import pytest
from mcp_helpers import (
    CARD_CLAUDE,
    H_CLAUDE,
    HOST,
    NOT_BOUND,
    make_env,
)

from coordination.mcp.server import SUPPORTED_VERSIONS


@pytest.fixture
def env(pg_db):
    return make_env(pg_db)


def test_tools_list_is_nine_with_writes_on_and_six_with_writes_off(pg_db):
    on = make_env(pg_db, allow_writes=True)
    c = on.client()
    c.initialize(on.keys.claude)
    names = [t["name"] for t in c.tools(on.keys.claude)]
    assert names == ["a2a_hello", "a2a_inbox", "a2a_get", "a2a_wait", "a2a_peers", "a2a_runs", "a2a_send", "a2a_respond", "a2a_cancel"]

    off = make_env(pg_db, allow_writes=False)
    c = off.client()
    c.initialize(off.keys.claude)
    names = [t["name"] for t in c.tools(off.keys.claude)]
    assert names == ["a2a_hello", "a2a_inbox", "a2a_get", "a2a_wait", "a2a_peers", "a2a_runs"]


def test_tool_annotations_and_schemas_on_the_wire(env):
    c = env.client()
    c.initialize(env.keys.claude)
    tools = {t["name"]: t for t in c.tools(env.keys.claude)}
    for name in ("a2a_inbox", "a2a_get", "a2a_wait", "a2a_peers", "a2a_runs"):
        assert tools[name]["annotations"]["readOnlyHint"] is True
    for name in ("a2a_send", "a2a_respond", "a2a_cancel"):
        assert tools[name]["annotations"]["readOnlyHint"] is False
        assert tools[name]["annotations"]["destructiveHint"] is False
    # Decision Z15: the advertised maximum is the configured cap, not 240.
    assert tools["a2a_wait"]["inputSchema"]["properties"]["timeout_seconds"]["maximum"] == env.config.max_wait_s == 50
    assert tools["a2a_send"]["inputSchema"]["properties"]["wait_seconds"]["maximum"] == 50
    assert "240" not in str(tools)


def test_a_write_tool_is_unknown_while_writes_are_off(pg_db):
    env = make_env(pg_db, allow_writes=False)
    c = env.client()
    c.initialize(env.keys.claude)
    for name in ("a2a_send", "a2a_respond", "a2a_cancel", "shell", "a2a_hello_x"):
        reply = c.rpc(env.keys.claude, "tools/call", {"name": name, "arguments": {}})
        assert reply["error"]["code"] == -32602 and reply["error"]["message"] == "Unknown tool."


# scope matrix: the shared middleware runs in front of /mcp ------------------------------------


@pytest.mark.parametrize("method", ["POST", "GET", "DELETE"])
def test_remote_peer_and_status_client_keys_get_403_on_mcp(env, method):
    c = env.client()
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}
    for token in (env.keys.peer, env.keys.status):
        response = c.raw(token, body, method=method, session=None)
        assert response.status_code == 403
        assert response.headers["content-type"].startswith("application/problem+json")
        assert "mcp-session-id" not in response.headers
    assert len(c.http.app.state.mcp.sessions) == 0  # nothing was created


def test_no_key_or_a_wrong_key_is_401_and_a_bad_host_is_421(env):
    c = env.client()
    body = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    assert c.raw(None, body, session=None).status_code == 401
    assert c.raw("a2ak_dev_deadbeef_" + "x" * 43, body, session=None).status_code == 401
    assert c.raw(env.keys.claude, body, session=None, headers={"Host": "evil.example"}).status_code == 421
    assert c.raw(env.keys.claude, body, session=None, headers={"Origin": "http://evil.example"}).status_code == 403


def test_the_endpoint_fails_closed_without_the_middleware(env):
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from coordination.mcp import build_endpoint

    endpoint = build_endpoint(env.config, env.service, env.engine, env.clock)
    bare = Starlette(routes=[Route("/mcp", endpoint, methods=["POST"])])
    response = TestClient(bare, base_url=f"http://{HOST}").post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401


# the wire ---------------------------------------------------------------------------------------


def test_discover_advertises_only_the_stateful_versions_and_needs_no_session(env):
    c = env.client()
    reply = c.rpc(env.keys.claude, "server/discover", {}, session=None)
    assert reply["result"]["supportedVersions"] == list(SUPPORTED_VERSIONS)
    assert "2026-07-28" not in str(reply)
    # With the headers a 2026 client sends, it still gets the override, never a 5xx.
    response = c.raw(
        env.keys.claude,
        {"jsonrpc": "2.0", "id": 9, "method": "server/discover"},
        session=None,
        headers={"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover"},
    )
    assert response.status_code == 200 and response.json()["result"]["supportedVersions"] == list(SUPPORTED_VERSIONS)


@pytest.mark.parametrize("version", ["2025-03-26", "2025-06-18", "2025-11-25"])
def test_initialize_negotiates_and_issues_a_session_id(env, version):
    c = env.client()
    reply = c.initialize(env.keys.claude, version)
    assert reply["result"]["protocolVersion"] == version
    assert reply["result"]["capabilities"] == {"tools": {"listChanged": False}}
    assert len(c.session_id) == 32 and int(c.session_id, 16) >= 0


def test_initialize_with_an_unsupported_version_offers_the_newest_stateful_one(env):
    c = env.client()
    assert c.initialize(env.keys.claude, "2026-07-28")["result"]["protocolVersion"] == SUPPORTED_VERSIONS[0]


def test_get_is_405_and_delete_ends_the_session(env):
    c = env.client()
    c.initialize(env.keys.claude)
    got = c.raw(env.keys.claude, None, method="GET")
    assert got.status_code == 405 and got.headers["allow"] == "POST, DELETE"
    sid = c.session_id
    assert c.raw(env.keys.claude, None, method="DELETE").status_code == 200
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 5, "method": "ping"}, session=sid).status_code == 404
    assert c.raw(env.keys.claude, None, method="DELETE").status_code == 404


def test_session_header_rules(env):
    c = env.client()
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    assert c.raw(env.keys.claude, ping, session=None).status_code == 400  # no header
    assert c.raw(env.keys.claude, ping, session="0" * 32).status_code == 404  # unknown: the client re-initialises
    c.initialize(env.keys.claude)
    assert c.raw(env.keys.claude, ping).status_code == 200


def test_a_session_id_is_tied_to_the_key_that_made_it(env):
    """SP5 D12 finding 1: the SDK ran key B's request with key A's session. This server refuses."""
    a = env.client()
    a.initialize(env.keys.claude)
    assert a.call(env.keys.claude, "a2a_hello", {"name": "alpha"}).data["bound"] is True
    # Key B (another key of the same card, and one of another card) presents A's session id.
    for token in (env.keys.claude_other, env.keys.mac):
        stolen = a.raw(token, {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "a2a_inbox", "arguments": {}}})
        assert stolen.status_code == 403
        assert "result" not in stolen.json()
        assert a.raw(token, None, method="DELETE").status_code == 403
    # A's own session still works and keeps its binding.
    assert a.call(env.keys.claude, "a2a_inbox").is_error is False


def test_malformed_requests(env):
    c = env.client()
    c.initialize(env.keys.claude)
    assert c.raw(env.keys.claude, b"{not json").status_code == 400
    assert c.raw(env.keys.claude, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}]).status_code == 400  # batches
    assert c.raw(env.keys.claude, {"id": 1, "method": "ping"}).status_code == 400  # not 2.0
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": True, "method": "ping"}).status_code == 400
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]}).json()["error"]["code"] == -32602
    unknown = c.rpc(env.keys.claude, "resources/list", {})
    assert unknown["error"]["code"] == -32601
    # A response to a server request is accepted and ignored.
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 1, "result": {}}).status_code == 202
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": [1]}}).status_code == 202


def test_responses_are_not_cached(env):
    c = env.client()
    response = c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}, session=None)
    assert response.headers["cache-control"] == "no-store"


def test_a_session_idle_past_the_ttl_is_gone_and_the_client_recovers(env):
    c = env.client()
    c.initialize(env.keys.claude)
    assert c.call(env.keys.claude, "a2a_hello", {"name": "alpha"}).is_error is False
    env.clock.advance(hours=env.config.session_idle_ttl_h + 1)
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 3, "method": "ping"}).status_code == 404
    c.initialize(env.keys.claude)
    assert c.call(env.keys.claude, "a2a_inbox").text == NOT_BOUND


def test_revoking_a_key_drops_its_sessions(env):
    c = env.client()
    c.initialize(env.keys.claude)
    mcp = c.http.app.state.mcp
    assert mcp.sessions.drop_key(env.keys.ids["claude"]) == 1
    assert c.raw(env.keys.claude, {"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 404


def test_the_unbound_error_text_is_the_constant(env):
    assert NOT_BOUND == "Not bound. Call a2a_hello."
    c = env.client()
    c.initialize(env.keys.claude)
    for tool, args in (
        ("a2a_inbox", {}),
        ("a2a_get", {"task_id": "x"}),
        ("a2a_wait", {"timeout_seconds": 1}),
        ("a2a_peers", {}),
        ("a2a_runs", {}),
        ("a2a_send", {"to": CARD_CLAUDE, "text": "t"}),
        ("a2a_respond", {"task_id": "x", "state": "working"}),
        ("a2a_cancel", {"task_id": "x"}),
    ):
        result = c.call(env.keys.claude, tool, args)
        assert result.is_error and result.text == NOT_BOUND, tool
        assert result.data == {"error": "not_bound", "message": NOT_BOUND}


def test_a_tool_error_is_a_result_the_model_can_read(env):
    env.add_session(H_CLAUDE)
    c = env.client()
    c.initialize(env.keys.claude)
    c.call(env.keys.claude, "a2a_hello", {"handle": H_CLAUDE})
    for args in ({"limit": 0}, {"limit": "five"}, {"nope": 1}):
        result = c.call(env.keys.claude, "a2a_inbox", args)
        assert result.is_error and result.text.startswith("invalid_params: ")
    arguments_not_object = c.rpc(env.keys.claude, "tools/call", {"name": "a2a_inbox", "arguments": [1]})["result"]
    assert arguments_not_object["isError"] is True
